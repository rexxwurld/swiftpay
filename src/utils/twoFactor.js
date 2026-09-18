// src/utils/twoFactor.js
const crypto = require('crypto');
const { authenticator } = require('otplib');

function generateTotpSecret() {
  return authenticator.generateSecret();
}

function buildOtpAuthUrl(email, secret) {
  return authenticator.keyuri(email, 'SwiftPay', secret);
}

function verifyTotpToken(secret, token) {
  if (!token) return false;
  try {
    return authenticator.check(String(token), secret);
  } catch {
    return false;
  }
}

// Backup codes: shown once in plaintext, stored hashed (same pattern as
// secret keys). Each one is single-use - the caller is responsible for
// removing a matched hash from the stored list after successful use.
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(5).toString('hex'));
  }
  return codes;
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

module.exports = {
  generateTotpSecret,
  buildOtpAuthUrl,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCode,
};
