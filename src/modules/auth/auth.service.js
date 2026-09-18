// src/modules/auth/auth.service.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Merchant = require('../merchant/merchant.model');
const { generateKeyPair, hashSecretKey, generateWebhookSecret } = require('../../utils/apiKeys');
const {
  generateTotpSecret,
  buildOtpAuthUrl,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCode,
} = require('../../utils/twoFactor');
const auditLog = require('../audit/auditLog.service');
const { jwtSecret, jwtExpiresIn } = require('../../config/env');

const VALID_PLANS = ['starter', 'growth', 'enterprise'];

async function registerMerchant({ businessName, email, password, plan }) {
  const existing = await Merchant.findOne({ email });
  if (existing) throw new Error('email_already_registered');

  const passwordHash = await bcrypt.hash(password, 10);
  const test = generateKeyPair('test');
  const live = generateKeyPair('live');
  const webhookSecret = generateWebhookSecret();
  const resolvedPlan = VALID_PLANS.includes(plan) ? plan : 'starter';

  const merchant = await Merchant.create({
    businessName,
    email,
    passwordHash,
    plan: resolvedPlan,
    testPublicKey: test.publicKey,
    testSecretKeyHash: hashSecretKey(test.secretKey),
    livePublicKey: live.publicKey,
    liveSecretKeyHash: hashSecretKey(live.secretKey),
    webhookSecret,
  });

  return {
    merchant,
    testSecretKey: test.secretKey,
    liveSecretKey: live.secretKey,
    webhookSecret,
  };
}

async function loginMerchant({ email, password }) {
  const merchant = await Merchant.findOne({ email });
  if (!merchant) throw new Error('invalid_credentials');

  const valid = await bcrypt.compare(password, merchant.passwordHash);
  if (!valid) throw new Error('invalid_credentials');

  if (merchant.twoFactor?.enabled) {
    // Short-lived, single-purpose token - only usable at the 2FA verify
    // step, never accepted by requireApiKey as a real session.
    const tempToken = jwt.sign(
      { id: merchant._id, purpose: '2fa_pending' },
      jwtSecret,
      { expiresIn: '5m' }
    );
    return { merchant, requires2FA: true, tempToken };
  }

  const token = jwt.sign({ id: merchant._id }, jwtSecret, { expiresIn: jwtExpiresIn });
  return { merchant, requires2FA: false, token };
}

async function verifyTwoFactorLogin({ tempToken, token, backupCode }) {
  let decoded;
  try {
    decoded = jwt.verify(tempToken, jwtSecret);
  } catch {
    throw new Error('invalid_or_expired_2fa_session');
  }
  if (decoded.purpose !== '2fa_pending') throw new Error('invalid_or_expired_2fa_session');

  const merchant = await Merchant.findById(decoded.id);
  if (!merchant || !merchant.twoFactor?.enabled) throw new Error('invalid_or_expired_2fa_session');

  let usedBackupCode = false;

  if (token && verifyTotpToken(merchant.twoFactor.secret, token)) {
    // valid TOTP
  } else if (backupCode) {
    const hash = hashBackupCode(backupCode.trim().toLowerCase());

    // Atomic compare-and-remove: the $pull only happens as part of the
    // SAME update as the match on `twoFactor.backupCodeHashes: hash`, so
    // two simultaneous logins racing on the same backup code cannot both
    // read "still present" before either write commits - only the first
    // update actually matches a document (MongoDB decides), the second
    // finds nothing to update and fails below. A plain
    // read-then-splice-then-save here would let both requests succeed
    // (see audit report, High #16).
    const updated = await Merchant.findOneAndUpdate(
      { _id: merchant._id, 'twoFactor.backupCodeHashes': hash },
      { $pull: { 'twoFactor.backupCodeHashes': hash } },
      { new: true }
    );
    if (!updated) throw new Error('invalid_2fa_code');
    usedBackupCode = true;
  } else {
    throw new Error('invalid_2fa_code');
  }

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchant._id.toString(),
    action: usedBackupCode ? 'merchant.2fa_login_backup_code_used' : 'merchant.2fa_login_verified',
    entityType: 'Merchant',
    entityRef: merchant._id.toString(),
    severity: usedBackupCode ? 'warning' : 'info',
  });

  const sessionToken = jwt.sign({ id: merchant._id }, jwtSecret, { expiresIn: jwtExpiresIn });
  return { merchant, token: sessionToken };
}

async function setupTwoFactor(merchantId) {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) throw new Error('merchant_not_found');

  const secret = generateTotpSecret();
  merchant.twoFactor.pendingSecret = secret;
  await merchant.save();

  return { secret, otpauthUrl: buildOtpAuthUrl(merchant.email, secret) };
}

async function enableTwoFactor(merchantId, token) {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) throw new Error('merchant_not_found');
  if (!merchant.twoFactor.pendingSecret) throw new Error('2fa_setup_not_started');

  if (!verifyTotpToken(merchant.twoFactor.pendingSecret, token)) {
    throw new Error('invalid_2fa_code');
  }

  const backupCodes = generateBackupCodes();
  merchant.twoFactor.secret = merchant.twoFactor.pendingSecret;
  merchant.twoFactor.pendingSecret = undefined;
  merchant.twoFactor.enabled = true;
  merchant.twoFactor.backupCodeHashes = backupCodes.map(hashBackupCode);
  await merchant.save();

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'merchant.2fa_enabled',
    entityType: 'Merchant',
    entityRef: merchantId.toString(),
    severity: 'warning',
  });

  return { backupCodes };
}

async function disableTwoFactor(merchantId, { password, token }) {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) throw new Error('merchant_not_found');

  const validPassword = await bcrypt.compare(password || '', merchant.passwordHash);
  if (!validPassword) throw new Error('invalid_credentials');

  if (!merchant.twoFactor?.enabled) throw new Error('2fa_not_enabled');
  if (!verifyTotpToken(merchant.twoFactor.secret, token)) throw new Error('invalid_2fa_code');

  merchant.twoFactor.enabled = false;
  merchant.twoFactor.secret = undefined;
  merchant.twoFactor.pendingSecret = undefined;
  merchant.twoFactor.backupCodeHashes = [];
  await merchant.save();

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'merchant.2fa_disabled',
    entityType: 'Merchant',
    entityRef: merchantId.toString(),
    severity: 'warning',
  });

  return { disabled: true };
}

module.exports = {
  registerMerchant,
  loginMerchant,
  verifyTwoFactorLogin,
  setupTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
};
