// tests/integration/withdrawalAmbiguousOutcome.test.js
//
// withdrawal.service.js has the exact same "bank accepted but local
// finalization crashed -> must park as ambiguous, never auto-reverse"
// logic as payout.service.js (see payoutAmbiguousOutcome.test.js), but
// had no test of its own covering it. Mirrors that file's approach:
// mock finalizeReservedDebit to throw on its first call only, standing
// in for a DB hiccup right after the bank simulator said yes.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let finalizeReservedDebitCallCount = 0;
let finalizeReservedDebitShouldThrow = false;

jest.mock('../../src/modules/wallet/wallet.service', () => {
  const actual = jest.requireActual('../../src/modules/wallet/wallet.service');
  return {
    ...actual,
    finalizeReservedDebit: async (...args) => {
      finalizeReservedDebitCallCount += 1;
      if (finalizeReservedDebitShouldThrow && finalizeReservedDebitCallCount === 1) {
        throw new Error('simulated_local_db_failure_after_bank_accepted');
      }
      return actual.finalizeReservedDebit(...args);
    },
  };
});

let Merchant, Wallet;
let requestWithdrawal, finalizeWithdrawalSuccess;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Wallet = require('../../src/modules/wallet/wallet.model');

  ({ requestWithdrawal, finalizeWithdrawalSuccess } = require('../../src/modules/withdrawal/withdrawal.service'));
  global.__postDoubleEntry = require('../../src/modules/ledger/ledger.service').postDoubleEntry;
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
  finalizeReservedDebitCallCount = 0;
  finalizeReservedDebitShouldThrow = false;
});

async function makeMerchantWithVerifiedSettlementAccount() {
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
    settlementAccount: {
      bankCode: '044',
      accountNumber: '0123456789', // does NOT end in '0000' - bank simulator accepts it
      accountName: 'Test Merchant Settlement',
      verified: true,
      verifiedAt: new Date(),
    },
  });
}

async function fundWallet(merchantId, amount, { currency = 'NGN', mode = 'test' } = {}) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await global.__postDoubleEntry({
        entryGroup: `test_fund_${new mongoose.Types.ObjectId()}`,
        amount,
        currency,
        mode,
        sourceType: 'adjustment',
        sourceRef: new mongoose.Types.ObjectId().toString(),
        debit: { accountType: 'suspense', accountRef: 'test_funding_source', description: 'test fixture' },
        credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'test fixture' },
        session,
      });
      await Wallet.findOneAndUpdate(
        { merchant: merchantId, currency, mode },
        { $inc: { balance: amount } },
        { upsert: true, new: true, session }
      );
    });
  } finally {
    session.endSession();
  }
}

describe('withdrawal ambiguous-outcome handling', () => {
  it('parks the withdrawal as ambiguous (never reversed) when the bank accepted but local finalization crashed', async () => {
    const merchant = await makeMerchantWithVerifiedSettlementAccount();
    await fundWallet(merchant._id, 500_000);

    finalizeReservedDebitShouldThrow = true;

    const withdrawal = await requestWithdrawal({
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'wd-idem-ambiguous-1',
    });

    expect(withdrawal.status).toBe('ambiguous');
    expect(withdrawal.failureReason).toMatch(/local_finalization_failed_after_bank_success/);

    const wallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'test' });
    expect(wallet.reservedBalance).toBe(100_000); // still held, not released
    expect(wallet.balance).toBe(400_000);
  });

  it('sanity check: succeeds normally when local finalization does NOT fail', async () => {
    const merchant = await makeMerchantWithVerifiedSettlementAccount();
    await fundWallet(merchant._id, 500_000);

    finalizeReservedDebitShouldThrow = false;

    const withdrawal = await requestWithdrawal({
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'wd-idem-normal-1',
    });

    expect(withdrawal.status).toBe('successful');

    const wallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'test' });
    expect(wallet.reservedBalance).toBe(0);
    expect(wallet.balance).toBe(400_000);
  });

  it('a retried finalization can still succeed after the ambiguous outcome is confirmed', async () => {
    const merchant = await makeMerchantWithVerifiedSettlementAccount();
    await fundWallet(merchant._id, 500_000);

    finalizeReservedDebitShouldThrow = true;

    const withdrawal = await requestWithdrawal({
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'wd-idem-retry-1',
    });
    expect(withdrawal.status).toBe('ambiguous');

    finalizeReservedDebitShouldThrow = false;
    const finalized = await finalizeWithdrawalSuccess(withdrawal._id, 'confirmed_provider_ref');

    expect(finalized.status).toBe('successful');

    const wallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'test' });
    expect(wallet.reservedBalance).toBe(0);
  });
});
