const { verifySignature } = require('../../utils/webhookSignature');
const { confirmPayoutOutcome } = require('./payout.service');
const auditLog = require('../audit/auditLog.service');

async function receivePayoutWebhook(req, res) {
  const signature = req.headers['x-bank-signature'];

  if (!verifySignature(req.body, signature)) {
    await auditLog.record({ actorType: 'bank_partner', action: 'payout_webhook.invalid_signature', severity: 'critical', ip: req.ip });
    return res.status(401).json({ status: false, message: 'invalid_signature' });
  }

  const { reference, success, providerRef, failureReason } = req.body || {};
  if (!reference || typeof success !== 'boolean') {
    return res.status(400).json({ status: false, message: 'invalid_payload' });
  }

  try {
    const payout = await confirmPayoutOutcome({ reference, success, providerRef, failureReason });
    return res.status(200).json({ status: true, applied: !!payout });
  } catch (err) {
    await auditLog.record({ actorType: 'system', actorRef: 'payout_webhook', action: 'payout_webhook.processing_failed', severity: 'critical', metadata: { reference, error: err.message } });
    return res.status(500).json({ status: false, message: 'processing_failed' });
  }
}

module.exports = { receivePayoutWebhook };
