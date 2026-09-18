// src/modules/subscription/subscription.service.js
const Plan = require('./plan.model');
const Subscription = require('./subscription.model');
const Invoice = require('./invoice.model');
const Customer = require('../customer/customer.model');
const Merchant = require('../merchant/merchant.model');
const { assignVirtualAccount } = require('../virtualAccount/virtualAccount.service');
const { dispatchMerchantWebhook } = require('../../utils/merchantWebhook');
const auditLog = require('../audit/auditLog.service');
const { normalizeCurrency } = require('../../config/currencies');

const INTERVAL_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000, // calendar-naive on purpose; see addInterval() below for real months
  yearly: 365 * 24 * 60 * 60 * 1000,
};

// Real calendar arithmetic for monthly/yearly so a plan billed on the 31st
// doesn't drift earlier every cycle it hits a short month.
function addInterval(date, interval, count = 1) {
  const d = new Date(date);
  if (interval === 'monthly') {
    d.setMonth(d.getMonth() + count);
    return d;
  }
  if (interval === 'yearly') {
    d.setFullYear(d.getFullYear() + count);
    return d;
  }
  return new Date(d.getTime() + INTERVAL_MS[interval] * count);
}

async function createPlan({ merchantId, name, amount, currency, interval, intervalCount, mode }) {
  if (!name) throw new Error('plan_name_required');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('invalid_plan_amount');
  if (!INTERVAL_MS[interval]) throw new Error('invalid_interval');
  // No fallback default here on purpose: a plan's mode determines every
  // invoice and virtual account it will ever generate, so it must come
  // from an actual API key (test or live), never silently assumed (see
  // audit report, High #11 - this is the same class of bug as the
  // subscription cron defaulting to test-mode virtual accounts).
  if (mode !== 'test' && mode !== 'live') {
    throw new Error('plan_mode_required');
  }

  const plan = await Plan.create({
    merchant: merchantId,
    name,
    amount,
    currency: normalizeCurrency(currency),
    interval,
    intervalCount: intervalCount || 1,
    mode,
  });

  return plan;
}

async function listPlans(merchantId) {
  return Plan.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function subscribeCustomer({ merchantId, customerId, planCode }) {
  const plan = await Plan.findOne({ merchant: merchantId, planCode, active: true });
  if (!plan) throw new Error('unknown_or_inactive_plan');

  const customer = await Customer.findOne({ _id: customerId, merchant: merchantId });
  if (!customer) throw new Error('customer_not_found');

  const now = new Date();
  const periodEnd = addInterval(now, plan.interval, plan.intervalCount);

  const subscription = await Subscription.create({
    merchant: merchantId,
    customer: customerId,
    plan: plan._id,
    mode: plan.mode,
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    nextBillingDate: now, // first invoice generated immediately, see generateDueInvoices
  });

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'subscription.created',
    entityType: 'Subscription',
    entityRef: subscription._id.toString(),
    metadata: { planCode, customerId },
  });

  return subscription;
}

async function cancelSubscription({ merchantId, subscriptionId }) {
  const subscription = await Subscription.findOne({ _id: subscriptionId, merchant: merchantId });
  if (!subscription) throw new Error('subscription_not_found');

  subscription.status = 'cancelled';
  subscription.cancelledAt = new Date();
  await subscription.save();
  return subscription;
}

// Creates an Invoice + a dedicated virtual account for it, for every
// subscription whose nextBillingDate has arrived. Meant to be run on a
// schedule (see scripts/generate-invoices.js) - safe to call repeatedly,
// since the (subscription, periodStart) unique index on Invoice makes a
// duplicate invoice for the same cycle impossible.
async function generateDueInvoices() {
  const due = await Subscription.find({
    status: { $in: ['active', 'past_due'] },
    nextBillingDate: { $lte: new Date() },
  }).populate('plan');

  const results = [];

  for (const subscription of due) {
    const plan = subscription.plan;
    if (!plan || !plan.active) continue;

    const periodStart = subscription.currentPeriodStart;
    const periodEnd = subscription.currentPeriodEnd;

    const existing = await Invoice.findOne({ subscription: subscription._id, periodStart });
    if (existing) {
      results.push(existing);
    } else {
      try {
        const { account } = await assignVirtualAccount({
          merchantId: subscription.merchant,
          customerId: subscription.customer,
          amount: plan.amount,
          reference: `${subscription.subscriptionCode}_${periodStart.getTime()}`,
          // Without this, assignVirtualAccount()'s fail-safe default of
          // 'test' would silently kick in here, meaning a live
          // subscription's invoice could get a fake virtual account that
          // a real customer's bank transfer would never reach (see audit
          // report, High #11).
          mode: subscription.mode,
        });

        const invoice = await Invoice.create({
          merchant: subscription.merchant,
          customer: subscription.customer,
          subscription: subscription._id,
          amount: plan.amount,
          currency: plan.currency,
          mode: subscription.mode,
          periodStart,
          periodEnd,
          dueDate: periodEnd,
          virtualAccount: account._id,
        });

        await auditLog.record({
          actorType: 'system',
          actorRef: 'subscription_billing',
          action: 'invoice.generated',
          entityType: 'Invoice',
          entityRef: invoice._id.toString(),
          metadata: { subscriptionId: subscription._id.toString(), amount: plan.amount },
        });

        // Fire-and-forget in the sense that a delivery failure here must
        // never stop the billing sweep from advancing to the next
        // subscription - dispatchMerchantWebhook already owns its own
        // durable retry/backoff (see merchantWebhookWorker.js), so this
        // just needs to not throw the whole loop off course.
        const merchant = await Merchant.findById(subscription.merchant);
        if (merchant) {
          await dispatchMerchantWebhook(merchant, {
            type: 'invoice.created',
            data: invoice.toObject(),
          }).catch((err) => {
            console.error('[subscription] failed to dispatch invoice.created webhook for', invoice._id.toString(), err.message);
          });
        }

        results.push(invoice);
      } catch (err) {
        console.error('[subscription] failed to generate invoice for', subscription._id.toString(), err.message);
        continue;
      }
    }

    // Advance the subscription to its next cycle regardless of whether
    // this cycle's invoice ends up paid - past_due tracking happens via
    // markOverdueInvoices(), not by withholding the next cycle.
    subscription.currentPeriodStart = periodEnd;
    subscription.currentPeriodEnd = addInterval(periodEnd, plan.interval, plan.intervalCount);
    subscription.nextBillingDate = subscription.currentPeriodEnd;
    await subscription.save();
  }

  return results;
}

// Marks invoices past their due date (and never paid) as failed, and
// flips their subscription to past_due. Run this on the same schedule as
// generateDueInvoices, right after it.
async function markOverdueInvoices() {
  const overdue = await Invoice.find({
    status: 'pending',
    dueDate: { $lt: new Date() },
  });

  for (const invoice of overdue) {
    invoice.status = 'failed';
    await invoice.save();
    await Subscription.findByIdAndUpdate(invoice.subscription, { status: 'past_due' });

    const merchant = await Merchant.findById(invoice.merchant);
    if (merchant) {
      await dispatchMerchantWebhook(merchant, {
        type: 'invoice.overdue',
        data: invoice.toObject(),
      }).catch((err) => {
        console.error('[subscription] failed to dispatch invoice.overdue webhook for', invoice._id.toString(), err.message);
      });
    }
  }

  return overdue.length;
}

// Called from the webhook processor (via transaction.service hooks would
// be circular; instead this is called by the invoice controller/cron
// reconciliation path) once a transaction lands on an invoice's virtual
// account, to mark it paid and bring the subscription back to 'active'.
async function markInvoicePaidByTransaction(transaction) {
  const invoice = await Invoice.findOne({ virtualAccount: transaction.virtualAccount, status: 'pending' });
  if (!invoice) return null;

  invoice.status = 'paid';
  invoice.transaction = transaction._id;
  invoice.paidAt = new Date();
  await invoice.save();

  await Subscription.findByIdAndUpdate(invoice.subscription, { status: 'active' });

  // Runs inside outboxWorker.js's handling of the mark_invoice_paid
  // event (itself atomically enqueued with the financial commit - see
  // transaction.service.js). Deliberately NOT caught here, unlike the
  // invoice.created/invoice.overdue dispatches above in this file: this
  // one runs inside the outbox's own retry/backoff (same as the existing
  // dispatch_merchant_webhook case in outboxWorker.js), so letting a
  // failure to even enqueue the delivery propagate is what makes it
  // retried instead of silently dropped. Re-finding the invoice by
  // status:'pending' above is what makes a retry of this whole function
  // safe to repeat (an already-paid invoice simply won't match).
  const merchant = await Merchant.findById(invoice.merchant);
  if (merchant) {
    await dispatchMerchantWebhook(merchant, {
      type: 'invoice.paid',
      data: invoice.toObject(),
    });
  }

  return invoice;
}

async function listInvoices(merchantId, { subscriptionId } = {}) {
  const filter = { merchant: merchantId };
  if (subscriptionId) filter.subscription = subscriptionId;
  return Invoice.find(filter).sort({ createdAt: -1 });
}

module.exports = {
  createPlan,
  listPlans,
  subscribeCustomer,
  cancelSubscription,
  generateDueInvoices,
  markOverdueInvoices,
  markInvoicePaidByTransaction,
  listInvoices,
};
