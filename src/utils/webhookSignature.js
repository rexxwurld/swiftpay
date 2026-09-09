// src/utils/webhookSignature.js
// Every webhook the mock bank partner sends is HMAC-signed so the receiver
// can prove it really came from the bank partner and wasn't forged/replayed
// by a third party pretending a payment succeeded.

const crypto = require('crypto');
const { bankWebhookSecret } = require('../config/env');

function getPayloadBody(payload) {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (typeof payload === 'string') {
    return Buffer.from(payload, 'utf8');
  }

  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function signPayload(payload) {
  const body = getPayloadBody(payload);

  return crypto
    .createHmac('sha512', bankWebhookSecret)
    .update(body)
    .digest('hex');
}

function verifySignature(payload, signature) {
  if (!signature) return false;

  const expected = signPayload(payload);

  const receivedSignature = String(signature).replace(/^sha512=/i, '');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(receivedSignature, 'utf8');

  if (a.length !== b.length) return false;

  // Constant-time compare to avoid timing attacks.
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  signPayload,
  verifySignature
};
