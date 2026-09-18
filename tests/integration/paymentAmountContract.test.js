// tests/integration/paymentAmountContract.test.js
//
// Covers the most critical fix from the Sep 2026 transfer-only audit:
// initializePayment() used to do `Math.round(Number(amount) * 100)`,
// treating the incoming `amount` as MAJOR units (naira) despite the
// documented/required contract being minor units (kobo) - the same
// contract every other money-moving endpoint (payouts, withdrawals,
// refunds) already correctly used. A caller correctly sending 100000
// (meaning ₦1,000, per the spec's own example) would have had it
// silently amplified 100x to ₦100,000.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant, BankPartner, Checkout;
let initializePayment;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  BankPartner = require('../../src/modules/bankPartner/bankPartner.model');
  Checkout = require('../../src/modules/checkout/checkout.model');

  ({ initializePayment } = require('../../src/modules/payment/payment.service'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

async function makeMerchant() {
  const suffix = new mongoose.Types.ObjectId().toString();
  return Merchant.create({
    businessName: 'Test Merchant',
    email: `merchant_${suffix}@example.com`,
    passwordHash: 'not_a_real_hash',
    testPublicKey: `pk_test_${suffix}`,
    testSecretKeyHash: `hash_test_${suffix}`,
    livePublicKey: `pk_live_${suffix}`,
    liveSecretKeyHash: `hash_live_${suffix}`,
    isVerified: true,
  });
}

beforeEach(async () => {
  // mintTestVirtualAccount() (mode:'test' path) requires this exact bank
  // to exist - see bankPartner.service.js's default seed.
  await BankPartner.create({ name: 'RexxPay Bank', slug: 'rexxpay-bank' });
});

describe('payment amount contract: minor units, not naira x100', () => {
  it('an amount of 100000 (meaning \u20a61,000 in kobo) is stored as exactly 100000 minor units, not 10,000,000', async () => {
    const merchant = await makeMerchant();

    const result = await initializePayment({
      merchantId: merchant._id,
      merchantPlan: merchant.plan,
      amount: 100_000, // kobo - per the spec's own worked example, this is ₦1,000
      customer: { email: 'customer@example.com', name: 'Test Customer' },
      tx_ref: 'contract-test-1',
      baseUrl: 'https://swiftpay.test',
      mode: 'test',
    });

    const checkout = await Checkout.findOne({ txRef: 'contract-test-1' });
    expect(checkout).not.toBeNull();
    expect(checkout.amountExpected).toBe(100_000); // NOT 10,000,000
    expect(result.tx_ref).toBe('contract-test-1');
  });

  it('rejects a non-integer amount instead of silently rounding it (minor units are always whole numbers)', async () => {
    const merchant = await makeMerchant();

    await expect(
      initializePayment({
        merchantId: merchant._id,
        merchantPlan: merchant.plan,
        amount: 1000.5, // not a valid kobo value
        customer: { email: 'customer@example.com', name: 'Test Customer' },
        tx_ref: 'contract-test-2',
        baseUrl: 'https://swiftpay.test',
        mode: 'test',
      })
    ).rejects.toThrow('amount_must_be_integer_minor_units');
  });

  it('a small amount that used to clear the naira-based minimum by accident is correctly rejected in minor units', async () => {
    const merchant = await makeMerchant();

    // MIN_SINGLE_PAYMENT_MINOR defaults to 10000 (₦100.00). Sending literal
    // "50" used to mean ₦50 -> ₦5,000 after the old x100 bug - comfortably
    // over the minimum by accident. In minor units, 50 kobo is nowhere near
    // the ₦100 floor and must be rejected.
    await expect(
      initializePayment({
        merchantId: merchant._id,
        merchantPlan: merchant.plan,
        amount: 50,
        customer: { email: 'customer@example.com', name: 'Test Customer' },
        tx_ref: 'contract-test-3',
        baseUrl: 'https://swiftpay.test',
        mode: 'test',
      })
    ).rejects.toThrow('amount_below_minimum');
  });
});
