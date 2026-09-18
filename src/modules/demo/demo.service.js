// src/modules/demo/demo.service.js
//
// Backs the public /demo page - lets a visitor with no SwiftPay account
// click through a full test-mode checkout (virtual account -> simulated
// bank transfer -> success) to see how the product works before they
// sign up. Everything this touches is pinned to mode:'test' and to one
// dedicated, auto-provisioned "Demo Merchant" - a visitor can never
// reach a real merchant's data or a live transaction through this path.
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const Merchant = require('../merchant/merchant.model');
const { generateKeyPair, hashSecretKey, generateWebhookSecret } = require('../../utils/apiKeys');
const { initializePayment } = require('../payment/payment.service');

const DEMO_MERCHANT_EMAIL = process.env.DEMO_MERCHANT_EMAIL || 'demo@swiftpay.internal';
const DEMO_MAX_AMOUNT_MINOR = Number(process.env.DEMO_MAX_AMOUNT_MINOR || 50_000_00); // ₦50,000 ceiling, generous but not tied to real limits

let demoMerchantId = null; // cached after first lookup/creation per process

async function getOrCreateDemoMerchant() {
  if (demoMerchantId) return demoMerchantId;

  let merchant = await Merchant.findOne({ email: DEMO_MERCHANT_EMAIL });

  if (!merchant) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    const test = generateKeyPair('test');
    const live = generateKeyPair('live');

    merchant = await Merchant.create({
      businessName: 'SwiftPay Demo',
      email: DEMO_MERCHANT_EMAIL,
      passwordHash,
      plan: 'starter',
      testPublicKey: test.publicKey,
      testSecretKeyHash: hashSecretKey(test.secretKey),
      livePublicKey: live.publicKey,
      liveSecretKeyHash: hashSecretKey(live.secretKey),
      webhookSecret: generateWebhookSecret(),
      isVerified: true,
    });
    // Deliberately not logging/returning the generated secret keys -
    // nothing should ever authenticate as the demo merchant directly;
    // this module always calls the service layer in-process instead.
  }

  demoMerchantId = merchant._id;
  return demoMerchantId;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function startDemoCheckout({ amount, name, email, phone, baseUrl }) {
  const amountMinor = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new Error('invalid_amount');
  }
  if (amountMinor > DEMO_MAX_AMOUNT_MINOR) {
    throw new Error('demo_amount_too_large');
  }

  const trimmedName = (name || '').trim();
  const trimmedEmail = (email || '').trim().toLowerCase();
  const trimmedPhone = (phone || '').trim();

  if (!trimmedName) {
    throw new Error('name_required');
  }
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    throw new Error('valid_email_required');
  }

  const merchantId = await getOrCreateDemoMerchant();

  const result = await initializePayment({
    merchantId,
    amount: amountMinor, // this form collects naira from a human - convert to the API's minor-units contract here, not inside initializePayment
    customer: { email: trimmedEmail, name: trimmedName, phone: trimmedPhone || null },
    baseUrl,
    mode: 'test',
  });

  return result; // { link, tx_ref, accountNumber, mode: 'test' }
}

module.exports = { startDemoCheckout };
