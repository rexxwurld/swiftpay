// src/modules/payment/payment.controller.js
const { initializePayment, verifyPayment } = require('./payment.service');

async function initialize(req, res) {
  try {
    const { amount, customer, tx_ref, redirect_url } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Session-authenticated dashboard requests have mode === null.
    // Default them to test mode, same as Paystack/Flutterwave dashboards
    // do until a merchant is verified/activated for live payments. This
    // used to default to 'live' despite this comment saying otherwise -
    // a dashboard-authenticated session could silently create a real,
    // live virtual account (see audit report, High #10).
    const mode = req.merchant.mode || 'test';

    if (mode === 'live' && !req.merchant.isVerified) {
      return res.status(403).json({
        status: false,
        message: 'merchant_not_verified_for_live_payments',
      });
    }

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
