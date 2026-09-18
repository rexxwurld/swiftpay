// src/modules/recipient/recipient.controller.js
const {
  createRecipient,
  listForMerchant,
  getForMerchant,
  deactivateRecipient,
} = require('./recipient.service');

async function create(req, res) {
  try {
    const { label, bankCode, accountNumber, accountName } = req.body;
    const recipient = await createRecipient({
      merchantId: req.merchant.id,
      label,
      bankCode,
      accountNumber,
      accountName,
    });
    res.status(201).json({ status: true, data: recipient });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function list(req, res) {
  const recipients = await listForMerchant(req.merchant.id);
  res.json({ status: true, data: recipients });
}

async function getOne(req, res) {
  try {
    const recipient = await getForMerchant(req.merchant.id, req.params.id);
    res.json({ status: true, data: recipient });
  } catch (err) {
    res.status(404).json({ status: false, message: err.message });
  }
}

async function deactivate(req, res) {
  try {
    const recipient = await deactivateRecipient(req.merchant.id, req.params.id);
    res.json({ status: true, data: recipient });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { create, list, getOne, deactivate };
