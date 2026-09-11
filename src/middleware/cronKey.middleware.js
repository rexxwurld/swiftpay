// src/middleware/cronKey.middleware.js
//
// Guards scheduled cron endpoints.
// Uses a separate CRON_TRIGGER_KEY from INFRA_ADMIN_KEY so that
// external schedulers can trigger cron jobs without having access
// to operator/admin endpoints.
//
// Accepted credentials:
//   - x-cron-key header (preferred)
//   - ?cronKey=... query parameter (convenient for external cron services)
//
// Environment variable:
//   CRON_TRIGGER_KEY
//
// Security:
//   - Fails closed when CRON_TRIGGER_KEY is not configured.
//   - Uses crypto.timingSafeEqual for the secret comparison.
//   - Pads buffers before comparison so different-length secrets do
//     not cause timingSafeEqual() to throw.
//

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
  if (!process.env.CRON_TRIGGER_KEY) {
    return res.status(500).json({
      status: false,
      message: 'cron_key_not_configured',
    });
  }

  // Header is preferred because query parameters can appear in
  // browser history, proxy logs, monitoring logs, etc.
  //
  // Query parameter is supported because external cron services can
  // conveniently call:
  //
  //   /api/admin/cron/job-name?cronKey=YOUR_CRON_KEY
  //
  const suppliedKey = req.headers['x-cron-key'] || req.query.cronKey;

  if (
    !suppliedKey ||
    !timingSafeStringEqual(suppliedKey, process.env.CRON_TRIGGER_KEY)
  ) {
    return res.status(401).json({
      status: false,
      message: 'unauthorized',
    });
  }

  next();
};
