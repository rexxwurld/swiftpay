// src/modules/auth/auth.controller.js
const {
  registerMerchant,
  loginMerchant,
  verifyTwoFactorLogin,
  setupTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
} = require('./auth.service');

// Secure is conditional on NODE_ENV (not hardcoded true) so local HTTP
// development still works - browsers silently drop a Secure cookie sent
// over plain HTTP, which would otherwise break local login entirely.
// Production always runs over HTTPS, so this is unconditional there (see
// audit report, Medium #23).
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
};

async function register(req, res) {
  try {
    const { businessName, email, password, plan } = req.body;
    const { merchant, testSecretKey, liveSecretKey, webhookSecret } = await registerMerchant({ businessName, email, password, plan });
    res.status(201).json({
      status: true,
      message: 'Merchant registered. Store your secret keys and webhook secret now - they will not be shown again.',
      data: {
        merchantId: merchant._id,
        businessName: merchant.businessName,
        email: merchant.email,
        plan: merchant.plan,
        testPublicKey: merchant.testPublicKey,
        testSecretKey,
        livePublicKey: merchant.livePublicKey,
        liveSecretKey,
        webhookSecret,
      },
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    const result = await loginMerchant({ email, password });

    if (result.requires2FA) {
      return res.json({
        status: true,
        requires2FA: true,
        tempToken: result.tempToken,
        message: 'Password verified. Enter your 2FA code to complete login.',
      });
    }

    res.cookie('token', result.token, SESSION_COOKIE_OPTIONS);
    res.json({
      status: true,
      data: { merchantId: result.merchant._id, businessName: result.merchant.businessName, email: result.merchant.email },
      token: result.token,
    });
  } catch (err) {
    res.status(401).json({ status: false, message: err.message });
  }
}

async function verifyTwoFactor(req, res) {
  try {
    const { tempToken, token, backupCode } = req.body;
    const { merchant, token: sessionToken } = await verifyTwoFactorLogin({ tempToken, token, backupCode });
    res.cookie('token', sessionToken, SESSION_COOKIE_OPTIONS);
    res.json({
      status: true,
      data: { merchantId: merchant._id, businessName: merchant.businessName, email: merchant.email },
      token: sessionToken,
    });
  } catch (err) {
    res.status(401).json({ status: false, message: err.message });
  }
}

async function setup2FA(req, res) {
  try {
    const result = await setupTwoFactor(req.merchant.id);
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function enable2FA(req, res) {
  try {
    const { token } = req.body;
    const result = await enableTwoFactor(req.merchant.id, token);
    res.json({
      status: true,
      message: '2FA enabled. Store these backup codes now - they will not be shown again.',
      data: result,
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function disable2FA(req, res) {
  try {
    const { password, token } = req.body;
    const result = await disableTwoFactor(req.merchant.id, { password, token });
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

function logout(req, res) {
  res.clearCookie('token', SESSION_COOKIE_OPTIONS);
  res.json({ status: true, message: 'Logged out' });
}

module.exports = { register, login, logout, verifyTwoFactor, setup2FA, enable2FA, disable2FA };
