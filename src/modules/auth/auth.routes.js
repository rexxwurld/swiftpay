// src/modules/auth/auth.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const {
  register,
  login,
  logout,
  verifyTwoFactor,
  setup2FA,
  enable2FA,
  disable2FA,
} = require('./auth.controller');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);

// Second step of login when the merchant has 2FA enabled - takes the
// short-lived tempToken from /login, not a full session.
router.post('/2fa/verify', verifyTwoFactor);

// Managing 2FA requires an already-authenticated session.
router.post('/2fa/setup', requireApiKey, setup2FA);
router.post('/2fa/enable', requireApiKey, enable2FA);
router.post('/2fa/disable', requireApiKey, disable2FA);

module.exports = router;
