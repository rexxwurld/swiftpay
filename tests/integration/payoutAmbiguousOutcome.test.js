// tests/integration/payoutAmbiguousOutcome.test.js
//
// Regression test for one of the audit report's nastiest findings
// (Critical #5): if the bank accepts a payout instruction and THEN
// SwiftPay's own local bookkeeping fails (a DB hiccup while recording
// the success), the payout must NEVER be automatically reversed - the
// bank may already have sent real money, and telling the merchant
// "it came back" would be a lie.
//
// This simulates that exact crash window by mocking finalizeReservedDebit
// (wallet.service) to throw on its first call - standing in for "the
// process died / the DB write failed right after the bank said yes" -
// while everything else (fund reservation, the bank simulator, Mongo
// itself) runs for real against an in-memory replica set.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

// Partial mock: keep reserveFundsWithLedgerEntry/releaseReservedFunds/
// getOrCreateWallet real (delegate to the actual module), but make
// finalizeReservedDebit throw on its first invocation only.
let mockFinalizeReservedDebitCallCount = 0;
let mockFinalizeReservedDebitShouldThrow = false;

jest.mock('../../src/modules/wallet/wallet.service', () => {
  const actual = jest.requireActual('../../src/modules/wallet/wallet.service');
  return {
    ...actual,
    finalizeReservedDebit: async (...args) => {
      mockFinalizeReservedDebitCallCount += 1;
      if (mockFinalizeReservedDebitShouldThrow && mockFinalizeReservedDebitCallCount === 1) {
        throw new Error('simulated_local_db_failure_after_bank_accepted');
      }
      return actual.finalizeReservedDebit(...args);
    },
  };
});

let Merchant, Payout, Wallet;
let requestPayout;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Payout = require('../../src/modules/payout/payout.model');
  Wallet = require('../../src/modules/wallet/wallet.model');

  ({ requestPayout } = require('../../src/modules/payout/payout.service'));
  const { postDoubleEntry } = require('../../src/modules/ledger/ledger.service');
  global.__postDoubleEntry = postDoubleEntry; // stash for fixture use below
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
  mockFinalizeReservedDebitCallCount = 0;
  mockFinalizeReservedDebitShouldThrow = false;
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
      const wallet = await Wallet.findOneAndUpdate(
        { merchant: merchantId, currency, mode },
        { $inc: { balance: amount } },
        { upsert: true, new: true, session }
      );
      return wallet;
    });
  } finally {
    session.endSession();
  }
}

describe('payout ambiguous-outcome handling', () => {
  it('parks the payout as ambiguous (never reversed) when the bank accepted but local finalization crashed', async () => {
    const merchant = await makeMerchant();
    await fundWallet(merchant._id, 500_000);

    mockFinalizeReservedDebitShouldThrow = true;

    const payout = await requestPayout({
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'idem-ambiguous-1',
      destinationBankCode: '044',
      destinationAccountNumber: '0123456789', // does NOT end in '0000' - bank simulator accepts it
      destinationAccountName: 'Recipient Name',
    });

    // The critical assertion: NOT 'reversed', NOT 'failed'. The bank
    // said yes; a local hiccup afterward must not overrule that.
    expect(payout.status).toBe('ambiguous');
    expect(payout.failureReason).toMatch(/local_finalization_failed_after_bank_success/);

    // The wallet's reserved funds must still be held, not released back
    // to available balance - releasing them while the bank may have
    // already paid out would let the merchant spend the same money twice.
    const wallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'test' });
    expect(wallet.reservedBalance).toBe(100_000);
    expect(wallet.balance).toBe(400_000); // 500,000 - 100,000 reserved
  });

  it('sanity check: succeeds normally when local finalization does NOT fail', async () => {
    const merchant = await makeMerchant();
    await fundWallet(merchant._id, 500_000);

    mockFinalizeReservedDebitShouldThrow = false;

    const payout = await requestPayout({
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'idem-normal-1',
      destinationBankCode: '044',
      destinationAccountNumber: '0123456789',
      destinationAccountName: 'Recipient Name',
    });

    expect(payout.status).toBe('successful');

    const wallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'test' });
    expect(wallet.reservedBalance).toBe(0); // reservation cleared on successful finalization
    expect(wallet.balance).toBe(400_000);
  });

  it('a retried finalization (e.g. via reconcile-outbound) can still succeed after the ambiguous outcome is confirmed', async () => {
    const merchant = await makeMerchant();
    await fundWallet(merchant._id, 500_000);

    mockFinalizeReservedDebitShouldThrow = true;

    const payout = await requestPayout({
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'idem-retry-1',
      destinationBankCode: '044',
      destinationAccountNumber: '0123456789',
      destinationAccountName: 'Recipient Name',
    });
    expect(payout.status).toBe('ambiguous');

    // Now simulate an operator (or reconcile-outbound.js) confirming with
    // the bank that the payout really did succeed, and retrying
    // finalization - this time without the injected failure.
    mockFinalizeReservedDebitShouldThrow = false;
    const { finalizePayoutSuccess } = require('../../src/modules/payout/payout.service');
    const finalized = await finalizePayoutSuccess(payout._id, 'confirmed_provider_ref');

    expect(finalized.status).toBe('successful');

    const wallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'test' });
    expect(wallet.reservedBalance).toBe(0);
  });
});
