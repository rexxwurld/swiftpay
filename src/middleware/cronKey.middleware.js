// src/middleware/cronKey.middleware.js
// Guards the /cron/* routes, which an external scheduler (cron-job.org,
// GitHub Actions, etc.) triggers by visiting a URL. Those services may
// log the URLs they call, so this key travels as a query parameter by
// design - which is exactly why it must be a SEPARATE secret from
// INFRA_ADMIN_KEY, not the same one. Rotate CRON_TRIGGER_KEY on its own
// schedule, independent of the operator admin key, and scope it to only
// what the cron routes actually do (release stale accounts, settlement,
// invoicing, reconciliation) - never anything that touches an
// individual stuck payment or a merchant's fee configuration; those
// stay behind requireAdminKey.

const crypto = require('crypto');

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  const maxLength = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLength);
  const paddedB = Buffer.alloc(maxLength);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  const contentsEqual = crypto.timingSafeEqual(paddedA, paddedB);
  return contentsEqual && bufA.length === bufB.length;
}

module.exports = function requireCronKey(req, res, next) {
  const key = req.headers['x-cron-key'] || req.query.cronKey;

  if (!process.env.CRON_TRIGGER_KEY) {
    // Fail closed: if no cron key is configured, nobody gets in.
    return res.status(500).json({ status: false, message: 'cron_key_not_configured' });
  }

  if (!key || !timingSafeStringEqual(key, process.env.CRON_TRIGGER_KEY)) {
    return res.status(401).json({ status: false, message: 'unauthorized' });
  }

  next();
};
