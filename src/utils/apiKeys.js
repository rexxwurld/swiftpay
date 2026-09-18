// src/utils/apiKeys.js
const crypto = require('crypto');

function generateKeyPair(mode = 'test') {
  const publicKey = `pk_${mode}_${crypto.randomBytes(20).toString('hex')}`;
  const secretKey = `sk_${mode}_${crypto.randomBytes(20).toString('hex')}`;
  return { publicKey, secretKey };
}

function hashSecretKey(secretKey) {
  return crypto.createHash('sha256').update(secretKey).digest('hex');
}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

module.exports = { generateKeyPair, hashSecretKey, generateWebhookSecret };
