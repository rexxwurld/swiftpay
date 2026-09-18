// src/modules/refund/refund.webhook.controller.js
//
// This is the ONLY trusted source of "this refund actually completed"
// or "this refund was declined". Nothing else in this codebase is
// allowed to mark a refund 'successful', and reverseRefund() is only
// reachable through here (or from requestRefund()'s own submission-time
// failure handling) - mirrors webhook.controller.js's role for inbound
// payments.
//
// Kept deliberately thin, same reasoning as the inbound bank webhook:
// verify signature, then hand off to the service layer, which owns its
// own atomic idempotency guard (see confirmRefundOutcome /
// reverseRefund in refund.service.js) - so it's safe for the bank to
// retry this webhook delivery as many times as it wants.
const { verifySignature } = require('../../utils/webhookSignature');
const { confirmRefundOutcome } = require('./refund.service');
const auditLog = require('../audit/auditLog.service');

async function receiveRefundWebhook(req, res) {
  const signature = req.headers['x-bank-signature'];

  if (!verifySignature(req.rawBody || req.body, signature)) {
    await auditLog.record({
      actorType: 'bank_partner',
      action: 'refund_webhook.invalid_signature',
      severity: 'critical',
      ip: req.ip,
      metadata: { bodyPreview: JSON.stringify(req.body).slice(0, 200) },
    });
    return res.status(401).json({ status: false, message: 'invalid_signature' });
  }

  const { reference, success, providerRef, failureReason } = req.body || {};

  if (!reference || typeof success !== 'boolean') {
    return res.status(400).json({ status: false, message: 'invalid_payload' });
  }

  try {
    const refund = await confirmRefundOutcome({ reference, success, providerRef, failureReason });

    // Always 200/ack once signature-verified and payload is well-formed -
    // even if confirmRefundOutcome found nothing to do (unknown/duplicate
    // reference). Returning an error here would make the bank retry a
    // webhook we've already correctly handled (or correctly ignored).
    return res.status(200).json({ status: true, applied: !!refund });
  } catch (err) {
    // A real failure (DB blip, bug) - let the bank retry this delivery.
    await auditLog.record({
      actorType: 'system',
      actorRef: 'refund_webhook',
      action: 'refund_webhook.processing_failed',
      severity: 'critical',
      metadata: { reference, error: err.message },
    });
    return res.status(500).json({ status: false, message: 'processing_failed' });
  }
}

module.exports = { receiveRefundWebhook };
