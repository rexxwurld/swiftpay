// src/modules/subaccount/subaccount.controller.js
const {
  createSubaccount,
  listForMerchant,
  getForMerchant,
  getBalance,
  settleSubaccount,
} = require('./subaccount.service');

async function create(req, res) {
  try {
    const {
      businessName,
      settlementBankCode,
      settlementAccountNumber,
      settlementAccountName,
      defaultSplitPercentage,
    } = req.body;

    const subaccount = await createSubaccount({
      merchantId: req.merchant.id,
      businessName,
      settlementBankCode,
      settlementAccountNumber,
      settlementAccountName,
      defaultSplitPercentage,
    });

    res.status(201).json({ status: true, data: subaccount });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function list(req, res) {
  const subaccounts = await listForMerchant(req.merchant.id);
  res.json({ status: true, data: subaccounts });
}

async function getOne(req, res) {
  try {
    const subaccount = await getForMerchant(req.merchant.id, req.params.id);
    // Array of { currency, mode, balance } - a subaccount can hold more
    // than one currency/mode balance at once, so this is never collapsed
    // into a single number (see subaccount.service.js).
    const balance = await getBalance(subaccount._id);
    res.json({ status: true, data: { ...subaccount.toObject(), balance } });
  } catch (err) {
    res.status(404).json({ status: false, message: err.message });
  }
}

async function settle(req, res) {
  try {
    await getForMerchant(req.merchant.id, req.params.id); // ownership check
    // One settlement per (currency, mode) balance bucket - see
    // subaccount.service.js for why this can no longer be a single number.
    const settlements = await settleSubaccount({ merchantId: req.merchant.id, subaccountId: req.params.id });
    res.status(201).json({ status: true, data: settlements });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { create, list, getOne, settle };
