// src/middleware/auth.middleware.js
const jwt = require('jsonwebtoken');
const Merchant = require('../modules/merchant/merchant.model');
const { hashSecretKey } = require('../utils/apiKeys');
const { jwtSecret } = require('../config/env');

async function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const [, bearer] = header.split('Bearer ');

  if (bearer && bearer.startsWith('sk_')) {
    const mode = bearer.startsWith('sk_live_') ? 'live' : bearer.startsWith('sk_test_') ? 'test' : null;
    if (!mode) {
      return res.status(401).json({ status: false, message: 'invalid_api_key' });
    }

    const hashField = mode === 'live' ? 'liveSecretKeyHash' : 'testSecretKeyHash';
    const merchant = await Merchant.findOne({ [hashField]: hashSecretKey(bearer) });
    if (!merchant) {
      return res.status(401).json({ status: false, message: 'invalid_api_key' });
    }
    req.merchant = { id: merchant._id, businessName: merchant.businessName, mode, plan: merchant.plan };
    return next();
  }

  const sessionToken = (bearer && !bearer.startsWith('sk_')) ? bearer : req.cookies?.token;
  if (sessionToken) {
    // CSRF defense-in-depth for the cookie-session path specifically.
    // sameSite: 'lax' on the cookie (see auth.controller.js) already
    // blocks the classic cross-site <form> POST attack on modern
    // browsers, but a plain HTML form also cannot set a custom header -
    // so requiring one here means state-changing requests must come
    // from actual same-origin JS (fetch/XHR), not a forged form,
    // even if sameSite behavior is ever loosened or a browser doesn't
        // enforce it.
    const isStateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const cameFromCookie = !bearer; // i.e. not an explicit Bearer token
    if (isStateChanging && cameFromCookie && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ status: false, message: 'csrf_check_failed' });
    }

    try {
      const decoded = jwt.verify(sessionToken, jwtSecret);
      // SECURITY: a 2FA-pending temp token (see auth.service.js loginMerchant)
      // is signed with this same secret but must NEVER be accepted as a full
      // session - it proves only that the password was correct, not the
      // second factor. Reject any token carrying a `purpose` claim here.
      if (decoded.purpose) {
        return res.status(401).json({ status: false, message: 'invalid_session' });
      }
      const merchant = await Merchant.findById(decoded.id);
      if (!merchant) throw new Error('merchant_not_found');
      req.merchant = { id: merchant._id, businessName: merchant.businessName, mode: null, plan: merchant.plan };
      return next();
    } catch {
      return res.status(401).json({ status: false, message: 'invalid_session' });
    }
  }

  return res.status(401).json({ status: false, message: 'missing_api_key' });
}

module.exports = { requireApiKey };
