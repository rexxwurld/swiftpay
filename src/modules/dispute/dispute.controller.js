// src/modules/dispute/dispute.controller.js
const { openDispute, submitEvidence, resolveDispute, listForMerchant, getForMerchant } = require('./dispute.service');

// Admin-only intake - see dispute.routes.js. Represents a chargeback
// notice arriving from a bank/card network, not a merchant-initiated action.
async function create(req, res) {
  try {
    const { merchantId, transactionId, amount, reason, reasonDetail } = req.body;
    const dispute = await openDispute({ merchantId, transactionId, amount, reason, reasonDetail });
    res.status(201).json({ status: true, data: dispute });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function list(req, res) {
  const disputes = await listForMerchant(req.merchant.id);
  res.json({ status: true, data: disputes });
}

async function getOne(req, res) {
  try {
    const dispute = await getForMerchant(req.merchant.id, req.params.id);
    res.json({ status: true, data: dispute });
  } catch (err) {
    res.status(404).json({ status: false, message: err.message });
  }
}

async function addEvidence(req, res) {
  try {
    const { description, url } = req.body;
    const dispute = await submitEvidence({ merchantId: req.merchant.id, disputeId: req.params.id, description, url });
    res.json({ status: true, data: dispute });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

// Admin-only resolution.
async function resolve(req, res) {
  try {
    const { outcome, resolution } = req.body;
    const dispute = await resolveDispute({ disputeId: req.params.id, outcome, resolution });
    res.json({ status: true, data: dispute });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { create, list, getOne, addEvidence, resolve };
