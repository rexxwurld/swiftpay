// src/modules/payment/payment.controller.js
const { initializePayment, verifyPayment } = require('./payment.service');

async function initialize(req, res) {
  try {
    const { amount, customer, tx_ref, redirect_url } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Session-authenticated dashboard requests have mode === null.
    // Default them to test mode, same as Paystack/Flutterwave dashboards
    // do until a merchant is verified/activated for live payments.
    const mode = req.merchant.mode || 'live';

    const result = await initializePayment({
      merchantId: req.merchant.id,
      merchantPlan: req.merchant.plan,
      amount,
      customer,
      tx_ref,
      redirect_url,
      baseUrl,
      mode,
    });
    res.status(201).json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function verify(req, res) {
  try {
    const result = await verifyPayment({ merchantId: req.merchant.id, tx_ref: req.params.tx_ref });
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { initialize, verify };
