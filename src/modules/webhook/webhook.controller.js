// src/modules/webhook/webhook.controller.js
const { verifySignature } = require('../../utils/webhookSignature');
const { enqueue } = require('./webhook.processor');
const auditLog = require('../audit/auditLog.service');

// This is the endpoint the (mock) bank partner calls when money lands on
// one of the pooled account numbers. It is the ONLY trusted source of
// "payment succeeded" - nothing else in this codebase is allowed to mark
// a transaction as successful or credit a wallet.
//
// Kept deliberately thin: verify signature, persist the raw event, ack
// fast (2xx), and let webhook.processor.js do the real work asynchronously.
// If we did the DB writes inline here and the bank has a short timeout,
// a slow DB moment could cause the bank to mark delivery as failed and
// retry a payment we actually already received - synchronous processing
// on the hot path is a reliability bug waiting to happen at scale.
async function receiveBankWebhook(req, res) {
  const signature = req.headers['x-bank-signature'];

  if (!verifySignature(req.rawBody || req.body, signature)) {
    // Do not process. Do not credit. Log for fraud review in a real system.
    await auditLog.record({
      actorType: 'bank_partner',
      action: 'webhook.invalid_signature',
      severity: 'critical',
      ip: req.ip,
      metadata: { bodyPreview: JSON.stringify(req.body).slice(0, 200) },
    });
    return res.status(401).json({ status: false, message: 'invalid_signature' });
  }

  const event = await enqueue({
  rawBody: req.body,
  signature,
  providerEventId:
    req.body.eventId ||
    req.body.providerEventId ||
    req.body.id 
});
  // 202: accepted for processing, not yet confirmed applied. The merchant
  // finds out the real outcome via their own webhook/polling of /transactions.
  return res.status(202).json({ status: true, message: 'accepted', eventId: event._id });
}

module.exports = { receiveBankWebhook };
