// src/middleware/adminKey.middleware.js
// Guards routes that should only be callable by you (the operator) -
// never by a merchant, even an authenticated one. Same pattern as
// RexxPay Bank's own admin key guard.
//
// SECURITY FIX: the previous version compared the supplied key with
// `!==`, which short-circuits on the first mismatched byte. That leaks
// timing information an attacker can use to guess the key one
// character at a time. We now always compare using
// crypto.timingSafeEqual, the same pattern already used correctly in
// utils/webhookSignature.js.

const crypto = require('crypto');

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  // timingSafeEqual throws if lengths differ, and comparing against a
  // buffer of a different length would itself leak length information.
  // Pad the shorter buffer so the comparison always runs, then fold
  // the length check into the final boolean - this keeps the total
  // work (and therefore the timing) independent of where the two
  // values first differ.
  const maxLength = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLength);
  const paddedB = Buffer.alloc(maxLength);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  const contentsEqual = crypto.timingSafeEqual(paddedA, paddedB);
  return contentsEqual && bufA.length === bufB.length;
}

module.exports = function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];

  if (!process.env.INFRA_ADMIN_KEY) {
    // Fail closed: if no admin key is configured, nobody gets in.
    return res.status(500).json({ status: false, message: 'admin_key_not_configured' });
  }

  if (!key || !timingSafeStringEqual(key, process.env.INFRA_ADMIN_KEY)) {
    return res.status(401).json({ status: false, message: 'unauthorized' });
  }

  next();
};
