// tests/integration/recipientVerification.test.js
//
// Covers the fix for a real gap found during the transfer-only audit:
// Recipient.accountName used to be stored verbatim from merchant input
// and used directly for live payouts, with no check against the bank at
// all. See recipient.service.js#createRecipient and
// payout.service.js#requestPayout.
//
// REXXPAY_BANK_ADMIN_KEY is intentionally left unset in the test env, so
// bankPartner.service.resolveBankAccount() fails closed immediately
// (no network call attempted - see the guard at the top of that
// function) and every recipient created here is expected to come out
// unverified. That's the scenario these tests are for: what happens
// when automated provider resolution ISN'T available.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant, Recipient;
let createRecipient;
let requestPayout;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Recipient = require('../../src/modules/recipient/recipient.model');

  ({ createRecipient } = require('../../src/modules/recipient/recipient.service'));
  ({ requestPayout } = require('../../src/modules/payout/payout.service'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

async function makeMerchant(overrides = {}) {
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
    ...overrides,
  });
}

describe('recipient creation without provider resolution available', () => {
  it('is created but left unverified, keeping the merchant-supplied name', async () => {
    const merchant = await makeMerchant();

    const recipient = await createRecipient({
      merchantId: merchant._id,
      label: 'Payroll - Jane',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'Jane Doe',
    });

    expect(recipient.verified).toBe(false);
    expect(recipient.verificationMethod).toBeNull();
    expect(recipient.verifiedAt).toBeNull();
    // Provider resolution wasn't available, so the merchant's own input
    // is kept as-is (not overwritten with a fabricated name) - it's just
    // not yet trusted for a live payout (see next describe block).
    expect(recipient.accountName).toBe('Jane Doe');
  });

  it('rejects an unrecognized bank code before ever touching the provider', async () => {
    const merchant = await makeMerchant();

    await expect(
      createRecipient({
        merchantId: merchant._id,
        label: 'Bad bank code',
        bankCode: 'not-a-real-code',
        accountNumber: '0123456789',
        accountName: 'Jane Doe',
      })
    ).rejects.toThrow('unknown_bank_code');
  });
});

describe('payout.service.js enforcement of recipient verification', () => {
  it('rejects a live-mode payout to an unverified recipient', async () => {
    const merchant = await makeMerchant();

    const recipient = await createRecipient({
      merchantId: merchant._id,
      label: 'Payroll - Jane',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'Jane Doe',
    });
    expect(recipient.verified).toBe(false); // sanity check on the fixture

    await expect(
      requestPayout({
        merchantId: merchant._id,
        amount: 50_000,
        currency: 'NGN',
        mode: 'live',
        idempotencyKey: `payout-to-unverified-${recipient._id}`,
        recipientCode: recipient.recipientCode,
      })
    ).rejects.toThrow('recipient_not_verified');
  });

  it('does NOT enforce verification in test mode (never reaches a real bank)', async () => {
    const merchant = await makeMerchant();

    const recipient = await createRecipient({
      merchantId: merchant._id,
      label: 'Payroll - Jane',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'Jane Doe',
    });

    // Should get past the verification gate in test mode and fail later
    // (insufficient funds) instead - proving the rejection above was
    // specifically the verification check, not something else.
    await expect(
      requestPayout({
        merchantId: merchant._id,
        amount: 50_000,
        currency: 'NGN',
        mode: 'test',
        idempotencyKey: `payout-test-mode-${recipient._id}`,
        recipientCode: recipient.recipientCode,
      })
    ).rejects.not.toThrow('recipient_not_verified');
  });

  it('admin verification (verified=true, verificationMethod=admin) lets a live payout past the gate', async () => {
    const merchant = await makeMerchant();

    const recipient = await createRecipient({
      merchantId: merchant._id,
      label: 'Payroll - Jane',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'Jane Doe',
    });

    // Simulates what PATCH /api/admin/recipients/:id/verify does - not
    // re-testing the route/auth here, just that requestPayout honors the
    // resulting state.
    recipient.verified = true;
    recipient.verifiedAt = new Date();
    recipient.verificationMethod = 'admin';
    await recipient.save();

    // Getting past 'recipient_not_verified' means the gate itself works;
    // this will still fail further down (no funded wallet, and the live
    // bank client has no network access in this test env) - both of
    // which are NOT 'recipient_not_verified', which is all this
    // assertion cares about.
    await expect(
      requestPayout({
        merchantId: merchant._id,
        amount: 50_000,
        currency: 'NGN',
        mode: 'live',
        idempotencyKey: `payout-verified-${recipient._id}`,
        recipientCode: recipient.recipientCode,
      })
    ).rejects.not.toThrow('recipient_not_verified');
  });
});
