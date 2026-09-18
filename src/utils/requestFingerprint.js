// src/utils/requestFingerprint.js
//
// An idempotency key is only safe if it's bound to the request it was
// first used for. Without this, `Idempotency-Key: ABC123` + amount
// ₦10,000, retried later as `Idempotency-Key: ABC123` + amount ₦500,000,
// would just silently return the original ₦10,000 operation - masking a
// client bug instead of catching it (see audit report, High #17).
//
// This produces a stable hash of the fields that define "what was
// actually requested", so a reused key can be checked against them.

const crypto = require('crypto');

/**
 * @param {object} fields - plain values that define the request's
 *   semantic identity (e.g. amount, currency, destination account).
 *   Order doesn't matter - keys are sorted before hashing.
 */
function computeRequestFingerprint(fields) {
  const normalized = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    normalized[key] = value === undefined || value === null ? null : String(value);
  }
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Throws a clear, non-financial error if an existing record's stored
 * fingerprint doesn't match the fingerprint of the current request - i.e.
 * the same idempotency key is being reused for a materially different
 * request. Never silently returns the old record in that case.
 */
function assertFingerprintMatches(existingFingerprint, currentFields) {
  const currentFingerprint = computeRequestFingerprint(currentFields);
  if (existingFingerprint && existingFingerprint !== currentFingerprint) {
    const err = new Error('idempotency_key_reused_with_different_request');
    err.code = 'IDEMPOTENCY_KEY_CONFLICT';
    throw err;
  }
  return currentFingerprint;
}

module.exports = { computeRequestFingerprint, assertFingerprintMatches };
