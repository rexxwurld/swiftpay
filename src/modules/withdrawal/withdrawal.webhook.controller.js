const { verifySignature } = require('../../utils/webhookSignature');
const { confirmWithdrawalOutcome } = require('./withdrawal.service');
const auditLog = require('../audit/auditLog.service');

async function receiveWithdrawalWebhook(req, res) {
  const signature = req.headers['x-bank-signature'];
  if (!verifySignature(req.rawBody || req.body, signature)) {
    await auditLog.record({ actorType: 'bank_partner', action: 'withdrawal_webhook.invalid_signature', severity: 'critical', ip: req.ip });
    return res.status(401).json({ status: false, message: 'invalid_signature' });
  }
  const { reference, success, providerRef, failureReason } = req.body || {};
  if (!reference || typeof success !== 'boolean') return res.status(400).json({ status: false, message: 'invalid_payload' });
  try {
    const withdrawal = await confirmWithdrawalOutcome({ reference, success, providerRef, failureReason });
    return res.status(200).json({ status: true, applied: !!withdrawal });
  } catch (err) {
    await auditLog.record({ actorType: 'system', actorRef: 'withdrawal_webhook', action: 'withdrawal_webhook.processing_failed', severity: 'critical', metadata: { reference, error: err.message } });
    return res.status(500).json({ status: false, message: 'processing_failed' });
  }
}
module.exports = { receiveWithdrawalWebhook };
