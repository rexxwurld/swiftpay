// src/middleware/adminAuth.middleware.js
const jwt = require('jsonwebtoken');
const { adminJwtSecret } = require('../config/env');

/**
 * requireAdminRole(...allowedRoles) - verifies an admin session JWT
 * (Authorization: Bearer <token>, obtained from POST /api/admin/auth/login)
 * and that the admin's role is one of `allowedRoles`. Attaches
 * `req.adminUser = { id, role }`.
 *
 * Applied IN ADDITION TO requireAdminKey on routes that move money or
 * change financial state, so those actions need both "has server/ops
 * access" (the shared key) and "is a specific named, authorized person"
 * (this). Order in the route chain doesn't matter for correctness, but
 * put requireAdminKey first so an unauthenticated scan of the admin
 * surface fails on the cheaper check.
 */
function requireAdminRole(...allowedRoles) {
  return function (req, res, next) {
    const header = req.headers.authorization || '';
    const [, token] = header.split('Bearer ');

    if (!token) {
      return res.status(401).json({ status: false, message: 'admin_session_required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, adminJwtSecret);
    } catch {
      return res.status(401).json({ status: false, message: 'invalid_or_expired_admin_session' });
    }

    if (decoded.purpose !== 'admin_session') {
      // Defense-in-depth: even though adminJwtSecret can be configured
      // to differ from the merchant jwtSecret, if an operator ever sets
      // them to the same value, this claim check stops a merchant
      // session token from being replayed here.
      return res.status(401).json({ status: false, message: 'invalid_or_expired_admin_session' });
    }

    if (!allowedRoles.includes(decoded.role)) {
      return res.status(403).json({ status: false, message: 'insufficient_admin_role' });
    }

    req.adminUser = { id: decoded.id, role: decoded.role };
    next();
  };
}

module.exports = { requireAdminRole };
