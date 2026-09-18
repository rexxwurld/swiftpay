// src/modules/subscription/subscription.controller.js
const {
  createPlan,
  listPlans,
  subscribeCustomer,
  cancelSubscription,
  listInvoices,
} = require('./subscription.service');
const Subscription = require('./subscription.model');

async function createPlanHandler(req, res) {
  try {
    const { name, amount, currency, interval, intervalCount } = req.body;
    const plan = await createPlan({
      merchantId: req.merchant.id,
      name,
      amount,
      currency,
      interval,
      intervalCount,
      // The API key used determines the plan's mode - never let the
      // caller pick this via the body (see audit report, High #11).
      mode: req.merchant.mode,
    });
    res.status(201).json({ status: true, data: plan });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function listPlansHandler(req, res) {
  const plans = await listPlans(req.merchant.id);
  res.json({ status: true, data: plans });
}

async function subscribeHandler(req, res) {
  try {
    const { customerId, planCode } = req.body;
    const subscription = await subscribeCustomer({ merchantId: req.merchant.id, customerId, planCode });
    res.status(201).json({ status: true, data: subscription });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function listSubscriptionsHandler(req, res) {
  const subscriptions = await Subscription.find({ merchant: req.merchant.id }).populate('plan').sort({ createdAt: -1 });
  res.json({ status: true, data: subscriptions });
}

async function cancelHandler(req, res) {
  try {
    const subscription = await cancelSubscription({ merchantId: req.merchant.id, subscriptionId: req.params.id });
    res.json({ status: true, data: subscription });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function listInvoicesHandler(req, res) {
  const invoices = await listInvoices(req.merchant.id, { subscriptionId: req.query.subscriptionId });
  res.json({ status: true, data: invoices });
}

module.exports = {
  createPlanHandler,
  listPlansHandler,
  subscribeHandler,
  listSubscriptionsHandler,
  cancelHandler,
  listInvoicesHandler,
};
