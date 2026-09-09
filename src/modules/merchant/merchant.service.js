// src/modules/merchant/merchant.service.js
const Merchant = require('./merchant.model');
const { generateKeyPair, hashSecretKey, generateWebhookSecret } = require('../../utils/apiKeys');
const auditLog = require('../audit/auditLog.service');

async function getProfile(merchantId) {
  return Merchant.findById(merchantId).select('-passwordHash -testSecretKeyHash -liveSecretKeyHash -webhookSecret');
}

// Only ever called explicitly by the merchant - never automatic. Old key
// stops working the instant this runs (the hash for that mode only is
// overwritten, not appended), so any integration still using it starts
// getting invalid_api_key immediately. The other mode's key is untouched.
// The plaintext secretKey is returned once here and is not retrievable
// again after this response - same rule as registration.
async function regenerateSecretKey(merchantId, mode) {
  if (mode !== 'test' && mode !== 'live') {
    throw new Error('invalid_mode');
  }

  const merchant = await Merchant.findById(merchantId);
  if (!merchant) throw new Error('merchant_not_found');

  const { secretKey } = generateKeyPair(mode);
  if (mode === 'live') {
    merchant.liveSecretKeyHash = hashSecretKey(secretKey);
  } else {
    merchant.testSecretKeyHash = hashSecretKey(secretKey);
  }
  await merchant.save();

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'merchant.secret_key_regenerated',
    entityType: 'Merchant',
    entityRef: merchantId.toString(),
    severity: 'warning',
    metadata: { mode },
  });

  return {
    mode,
    publicKey: mode === 'live' ? merchant.livePublicKey : merchant.testPublicKey,
    secretKey,
  };
}

async function updateWebhookUrl(merchantId, webhookUrl) {
  if (webhookUrl) {
    try { new URL(webhookUrl); } catch { throw new Error('invalid_webhook_url'); }
    if (!webhookUrl.startsWith('https://') && process.env.NODE_ENV === 'production') {
      throw new Error('webhook_url_must_be_https');
    }
  }
  return Merchant.findByIdAndUpdate(merchantId, { webhookUrl }, { new: true }).select(
    '-passwordHash -testSecretKeyHash -liveSecretKeyHash -webhookSecret'
  );
}

// Same rotation pattern as regenerateSecretKey() above: a fresh whsec_
// value is generated and saved, and returned in plaintext exactly once
// in this response - never retrievable again afterward (getProfile()
// and updateWebhookUrl() both explicitly exclude it). Old value stops
// verifying immediately, so any webhook already in flight when this
// runs will fail signature checks and get retried by the sender - same
// tradeoff a live key rotation has.
async function regenerateWebhookSecret(merchantId) {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) throw new Error('merchant_not_found');

  const webhookSecret = generateWebhookSecret();
  merchant.webhookSecret = webhookSecret;
  await merchant.save();

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'merchant.webhook_secret_regenerated',
    entityType: 'Merchant',
    entityRef: merchantId.toString(),
    severity: 'warning',
  });

  return { webhookSecret };
}

module.exports = { getProfile, updateWebhookUrl, regenerateSecretKey, regenerateWebhookSecret };
