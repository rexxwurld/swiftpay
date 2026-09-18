// src/modules/wallet/wallet.controller.js
const { getOrCreateWallet, listWallets } = require('./wallet.service');
const { normalizeCurrency } = require('../../config/currencies');

async function getWallet(req, res) {
  try {
    const currency = normalizeCurrency(req.query.currency || 'NGN');
    // API-key calls are pinned to whatever mode the key itself is for -
    // a test key can never be redirected to the live wallet via a query
    // param. Only session (dashboard) logins, which have no key-derived
    // mode, honor ?mode= - that's what the dashboard's test/live toggle
    // sends. Defaults to 'test' if the param is missing/invalid, same
    // fail-closed default as wallet.service.
    const requestedMode = req.query.mode === 'live' ? 'live' : 'test';
    const mode = req.merchant.mode || requestedMode;
    const wallet = await getOrCreateWallet(req.merchant.id, currency, mode);
    res.json({ status: true, data: wallet });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function getAllWallets(req, res) {
  // null mode = return both test and live wallets, each tagged by its
  // own `mode` field, so the dashboard can group/toggle them.
  const wallets = await listWallets(req.merchant.id, req.merchant.mode || null);
  res.json({ status: true, data: wallets });
}

module.exports = { getWallet, getAllWallets };
