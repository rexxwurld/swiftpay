// src/modules/settlement/settlement.controller.js
const { runSettlementCycle, listBatches } = require('./settlement.service');

// Manual trigger - the real trigger is the scheduled job
// (scripts/run-settlement.js), this exists so an operator can force a
// cycle out-of-band (e.g. after downtime) without SSH access, same
// convenience tradeoff as admin.routes.js's provision-pool endpoint.
async function runCycle(req, res) {
  try {
    const currency = req.query.currency || 'NGN';
    const mode = req.query.mode === 'test' ? 'test' : 'live';
    const result = await runSettlementCycle({ currency, mode });
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
}

async function batches(req, res) {
  try {
    const { currency, mode, phase, limit } = req.query;
    const result = await listBatches({ currency, mode, phase, limit: limit ? Number(limit) : undefined });
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
}

module.exports = { runCycle, batches };
