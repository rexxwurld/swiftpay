// src/modules/transaction/transaction.controller.js
const { listForMerchant } = require('./transaction.service');

async function list(req, res) {
  // API-key calls are pinned to the key's own mode. Session (dashboard)
  // logins honor ?mode= from the test/live toggle, defaulting to 'test'
  // so a merchant never lands on an unfiltered test+live mix without
  // asking for it.
  const requestedMode = req.query.mode === 'live' ? 'live' : 'test';
  const mode = req.merchant.mode || requestedMode;
  const transactions = await listForMerchant(req.merchant.id, mode);
  res.json({ status: true, data: transactions });
}

module.exports = { list };
