// src/modules/payout/payout.controller.js
const { requestPayout, requestBulkPayout, listForMerchant } = require('./payout.service');

async function create(req, res) {
  try {
    const { amount, currency, recipientCode, destinationBankCode, destinationAccountNumber, destinationAccountName } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || null;

    // Payouts must be triggered with an actual sk_test_/sk_live_ API
    // key, not a dashboard session - there's no safe "which wallet did
    // you mean" default for moving money out.
    if (req.merchant.mode !== 'test' && req.merchant.mode !== 'live') {
      return res.status(401).json({ status: false, message: 'api_key_required_for_payouts' });
    }

    if (req.merchant.mode === 'live' && !req.merchant.isVerified) {
      return res.status(403).json({ status: false, message: 'merchant_not_verified_for_live_payouts' });
    }

    const payout = await requestPayout({
      merchantId: req.merchant.id,
      amount,
      currency,
      idempotencyKey,
      recipientCode,
      destinationBankCode,
      destinationAccountNumber,
      destinationAccountName,
      mode: req.merchant.mode,
    });
    res.status(201).json({ status: true, data: payout });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function createBulk(req, res) {
  try {
    const { currency, items } = req.body;

    if (req.merchant.mode !== 'test' && req.merchant.mode !== 'live') {
      return res.status(401).json({ status: false, message: 'api_key_required_for_payouts' });
    }

    const result = await requestBulkPayout({
      merchantId: req.merchant.id,
      currency,
      items,
      mode: req.merchant.mode,
    });
    res.status(201).json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function list(req, res) {
  try {
    // Same pattern as wallet/transactions: API keys are pinned to their
    // own mode; session logins honor ?mode= from the dashboard toggle,
    // defaulting to 'test'.
    const requestedMode = req.query.mode === 'live' ? 'live' : 'test';
    const mode = req.merchant.mode || requestedMode;
    const payouts = await listForMerchant(req.merchant.id, mode);
    res.json({ status: true, data: payouts });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
}

module.exports = { create, createBulk, list };
