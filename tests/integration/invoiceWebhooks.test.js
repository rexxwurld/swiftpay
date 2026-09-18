// tests/integration/invoiceWebhooks.test.js
//
// Covers a real gap the README had logged since before this audit
// session: invoice lifecycle events never fired a merchant webhook,
// unlike every other event type (transaction.success, payout.success,
// etc). Added invoice.created (generateDueInvoices), invoice.paid
// (markInvoicePaidByTransaction, called from the outbox worker), and
// invoice.overdue (markOverdueInvoices) dispatches in
// subscription.service.js.
//
// merchantWebhookQueue.js needs a real Redis connection (BullMQ) with
// maxRetriesPerRequest:null, i.e. it will hang retrying rather than fail
// fast without one - mocked here the same way webhookQueue.js is mocked
// in adminOpsTooling.test.js, for the same reason (no Redis in this
// sandbox). dispatchMerchantWebhook() itself already tolerates a queue
// failure gracefully (creates the MerchantWebhookDelivery record first,
// logs and swallows an enqueue failure) - the mock just avoids actually
// touching the network at all.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

const mockEnqueueMerchantWebhookDelivery = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/queue/merchantWebhookQueue', () => ({
  enqueueMerchantWebhookDelivery: (...args) => mockEnqueueMerchantWebhookDelivery(...args),
}));

let Merchant, Customer, Plan, Subscription, Invoice, Transaction, BankPartner, MerchantWebhookDelivery;
let generateDueInvoices, markOverdueInvoices, markInvoicePaidByTransaction;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Customer = require('../../src/modules/customer/customer.model');
  Plan = require('../../src/modules/subscription/plan.model');
  Subscription = require('../../src/modules/subscription/subscription.model');
  Invoice = require('../../src/modules/subscription/invoice.model');
  Transaction = require('../../src/modules/transaction/transaction.model');
  BankPartner = require('../../src/modules/bankPartner/bankPartner.model');
  MerchantWebhookDelivery = require('../../src/modules/webhook/merchantWebhookDelivery.model');

  ({ generateDueInvoices, markOverdueInvoices, markInvoicePaidByTransaction } = require('../../src/modules/subscription/subscription.service'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
  mockEnqueueMerchantWebhookDelivery.mockClear();
});

async function makeMerchant({ withWebhook = true } = {}) {
  const suffix = new mongoose.Types.ObjectId().toString();
  return Merchant.create({
    businessName: 'Test Merchant',
    email: `merchant_${suffix}@example.com`,
    passwordHash: 'not_a_real_hash',
    testPublicKey: `pk_test_${suffix}`,
    testSecretKeyHash: `hash_test_${suffix}`,
    livePublicKey: `pk_live_${suffix}`,
    liveSecretKeyHash: `hash_live_${suffix}`,
    isVerified: true,
    ...(withWebhook ? { webhookUrl: 'https://merchant.example.com/webhooks', webhookSecret: 'whsec_test' } : {}),
  });
}

describe('invoice.paid webhook', () => {
  it('dispatches invoice.paid when a pending invoice is marked paid by a transaction', async () => {
    const merchant = await makeMerchant();
    const customer = await Customer.create({ merchant: merchant._id, fullName: 'Cust', email: 'cust@example.com' });
    const plan = await Plan.create({ merchant: merchant._id, name: 'Pro', amount: 500_000, mode: 'test', interval: 'monthly' });
    const subscription = await Subscription.create({
      merchant: merchant._id, customer: customer._id, plan: plan._id, mode: 'test',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      nextBillingDate: new Date(Date.now() + 30 * 86400000),
    });
    const virtualAccountId = new mongoose.Types.ObjectId();
    const invoice = await Invoice.create({
      merchant: merchant._id, customer: customer._id, subscription: subscription._id,
      amount: 500_000, mode: 'test',
      periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd,
      dueDate: subscription.currentPeriodEnd, virtualAccount: virtualAccountId, status: 'pending',
    });
    const transaction = await Transaction.create({
      reference: 'ref_1', merchant: merchant._id, customer: customer._id, virtualAccount: virtualAccountId,
      mode: 'test', amountReceived: 500_000, netAmount: 500_000, currency: 'NGN', status: 'success',
    });

    const result = await markInvoicePaidByTransaction(transaction);
    expect(result.status).toBe('paid');

    const delivery = await MerchantWebhookDelivery.findOne({ merchant: merchant._id, eventType: 'invoice.paid' });
    expect(delivery).not.toBeNull();
    expect(mockEnqueueMerchantWebhookDelivery).toHaveBeenCalledWith(delivery._id);
  });

  it('does not throw and skips dispatch when the merchant has no webhookUrl configured', async () => {
    const merchant = await makeMerchant({ withWebhook: false });
    const customer = await Customer.create({ merchant: merchant._id, fullName: 'Cust', email: 'cust2@example.com' });
    const plan = await Plan.create({ merchant: merchant._id, name: 'Pro', amount: 500_000, mode: 'test', interval: 'monthly' });
    const subscription = await Subscription.create({
      merchant: merchant._id, customer: customer._id, plan: plan._id, mode: 'test',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      nextBillingDate: new Date(Date.now() + 30 * 86400000),
    });
    const virtualAccountId = new mongoose.Types.ObjectId();
    await Invoice.create({
      merchant: merchant._id, customer: customer._id, subscription: subscription._id,
      amount: 500_000, mode: 'test',
      periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd,
      dueDate: subscription.currentPeriodEnd, virtualAccount: virtualAccountId, status: 'pending',
    });
    const transaction = await Transaction.create({
      reference: 'ref_2', merchant: merchant._id, customer: customer._id, virtualAccount: virtualAccountId,
      mode: 'test', amountReceived: 500_000, netAmount: 500_000, currency: 'NGN', status: 'success',
    });

    await expect(markInvoicePaidByTransaction(transaction)).resolves.toMatchObject({ status: 'paid' });
    expect(await MerchantWebhookDelivery.countDocuments({})).toBe(0);
  });
});

describe('invoice.overdue webhook', () => {
  it('dispatches invoice.overdue and marks the subscription past_due for each newly-overdue invoice', async () => {
    const merchant = await makeMerchant();
    const customer = await Customer.create({ merchant: merchant._id, fullName: 'Cust', email: 'cust3@example.com' });
    const plan = await Plan.create({ merchant: merchant._id, name: 'Pro', amount: 500_000, mode: 'test', interval: 'monthly' });
    const subscription = await Subscription.create({
      merchant: merchant._id, customer: customer._id, plan: plan._id, mode: 'test',
      currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
      nextBillingDate: new Date(),
    });
    await Invoice.create({
      merchant: merchant._id, customer: customer._id, subscription: subscription._id,
      amount: 500_000, mode: 'test',
      periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd,
      dueDate: new Date(Date.now() - 5 * 86400000), // already past due
      status: 'pending',
    });

    const count = await markOverdueInvoices();
    expect(count).toBe(1);

    const reloadedSub = await Subscription.findById(subscription._id);
    expect(reloadedSub.status).toBe('past_due');

    const delivery = await MerchantWebhookDelivery.findOne({ merchant: merchant._id, eventType: 'invoice.overdue' });
    expect(delivery).not.toBeNull();
  });
});

describe('invoice.created webhook', () => {
  beforeEach(async () => {
    await BankPartner.create({ name: 'RexxPay Bank', slug: 'rexxpay-bank' });
  });

  it('dispatches invoice.created when a due subscription generates a fresh invoice', async () => {
    const merchant = await makeMerchant();
    const customer = await Customer.create({ merchant: merchant._id, fullName: 'Cust', email: 'cust4@example.com' });
    const plan = await Plan.create({ merchant: merchant._id, name: 'Pro', amount: 500_000, mode: 'test', interval: 'monthly' });
    await Subscription.create({
      merchant: merchant._id, customer: customer._id, plan: plan._id, mode: 'test',
      currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: new Date(),
      nextBillingDate: new Date(Date.now() - 60000), // due
    });

    const results = await generateDueInvoices();
    expect(results).toHaveLength(1);

    const delivery = await MerchantWebhookDelivery.findOne({ merchant: merchant._id, eventType: 'invoice.created' });
    expect(delivery).not.toBeNull();
  });
});
