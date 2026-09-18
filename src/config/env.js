// src/config/env.js
require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // Deliberately a SEPARATE secret from jwtSecret (merchant sessions).
  // A merchant session token and an admin session token must never be
  // interchangeable, even accidentally - if they shared a secret, a bug
  // that forgot to check the `purpose`/role claim could let a merchant's
  // token be replayed against an admin route. Falls back to jwtSecret
  // only so local dev doesn't need two separate .env values to get
  // started; ALWAYS set ADMIN_JWT_SECRET to its own value in production.
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET,
  adminJwtExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h',

  // Must be IDENTICAL to BANK_WEBHOOK_SECRET set on RexxPay Bank -
  // this is what verifies incoming "payment succeeded" webhooks are real.
  bankWebhookSecret: process.env.BANK_WEBHOOK_SECRET,

  // RexxPay Bank (the real wallet system) - used to provision real pool
  // accounts instead of generating fake local account numbers.
  rexxPayBankBaseUrl: process.env.REXXPAY_BANK_BASE_URL || 'https://rexxpay.onrender.com',
  rexxPayBankAdminKey: process.env.REXXPAY_BANK_ADMIN_KEY,

  // Same shared secret as bankWebhookSecret above, reused to SIGN
  // outgoing payout instructions to RexxPay Bank (it verifies them with
  // its own SWIFTPAY_WEBHOOK_SECRET, which must be set to this same
  // value - see rexxpay-main's src/middleware/verifySwiftpaySignature.js).
  // Kept as its own name so the two directions can be rotated to
  // different secrets later without a confusing variable name.
  rexxPayBankPayoutSecret: process.env.REXXPAY_BANK_PAYOUT_SECRET || process.env.BANK_WEBHOOK_SECRET,

  // Identifies this service to RexxPay Bank in payout instructions - must
  // match the `linkedService` value SwiftPay's Wallet/SettlementPool
  // records use ("swiftpay").
  linkedServiceName: process.env.LINKED_SERVICE_NAME || 'swiftpay',
};
