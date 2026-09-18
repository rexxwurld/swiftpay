// tests/integration/settlement.test.js
//
// settlement.service.js (the pending_settlement -> settled -> available
// pipeline) had no test coverage at all before this file - the existing
// "settlement" test (subaccountSettlement.concurrency.test.js) covers a
// different concept (subaccount revenue splits), not this pipeline.
//
// Also covers the mode-isolation fix made during the Sep 2026
// transfer-only audit: before that fix, runSettlePhase/
// runMakeAvailablePhase queried transactions by currency alone, so a
// single batch (and its totalAmount) could silently mix live and test
// transactions together.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant, Transaction, Wallet;
let runSettlePhase, runMakeAvailablePhase;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Transaction = require('../../src/modules/transaction/transaction.model');
  Wallet = require('../../src/modules/wallet/wallet.model');

  ({ runSettlePhase, runMakeAvailablePhase } = require('../../src/modules/settlement/settlement.service'));
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

async function makePendingTransaction(merchant, { mode, netAmount }) {
  return Transaction.create({
    reference: `ref_${new mongoose.Types.ObjectId()}`,
    merchant: merchant._id,
    customer: new mongoose.Types.ObjectId(),
    virtualAccount: new mongoose.Types.ObjectId(),
    mode,
    amountReceived: netAmount,
    netAmount,
    currency: 'NGN',
    status: 'success',
    settlementStatus: 'pending_settlement',
  });
}

// Comfortably past both the default 24h settle cutoff and the default
// 0-minute make-available delay, regardless of when the transaction
// fixture's own createdAt landed.
const FAR_FUTURE = new Date(Date.now() + 25 * 60 * 60 * 1000);

describe('settlement.service mode isolation', () => {
  it('a live-mode settle batch never picks up a test-mode transaction, and vice versa', async () => {
    const merchant = await makeMerchant();
    const liveTxn = await makePendingTransaction(merchant, { mode: 'live', netAmount: 100_000 });
    const testTxn = await makePendingTransaction(merchant, { mode: 'test', netAmount: 200_000 });

    const liveBatch = await runSettlePhase({ currency: 'NGN', mode: 'live', now: FAR_FUTURE });
    expect(liveBatch.transactionCount).toBe(1);
    expect(liveBatch.totalAmount).toBe(100_000);
    expect(liveBatch.mode).toBe('live');

    const reloadedLive = await Transaction.findById(liveTxn._id);
    expect(reloadedLive.settlementStatus).toBe('settled');
    const reloadedTest = await Transaction.findById(testTxn._id);
    expect(reloadedTest.settlementStatus).toBe('pending_settlement'); // untouched by the live batch

    const testBatch = await runSettlePhase({ currency: 'NGN', mode: 'test', now: FAR_FUTURE });
    expect(testBatch.transactionCount).toBe(1);
    expect(testBatch.totalAmount).toBe(200_000);
    expect(testBatch.mode).toBe('test');

    const reloadedTestAfter = await Transaction.findById(testTxn._id);
    expect(reloadedTestAfter.settlementStatus).toBe('settled');
  });

  it('does not settle the same transaction twice across repeated runs', async () => {
    const merchant = await makeMerchant();
    await makePendingTransaction(merchant, { mode: 'live', netAmount: 50_000 });

    const first = await runSettlePhase({ currency: 'NGN', mode: 'live', now: FAR_FUTURE });
    expect(first.transactionCount).toBe(1);

    const second = await runSettlePhase({ currency: 'NGN', mode: 'live', now: FAR_FUTURE });
    expect(second.transactionCount).toBe(0); // nothing left in pending_settlement
    expect(second.totalAmount).toBe(0);
  });
});

describe('settlement.service settle -> available pipeline', () => {
  it('moves a settled transaction to available and credits the correct mode-scoped wallet', async () => {
    const merchant = await makeMerchant();
    await makePendingTransaction(merchant, { mode: 'live', netAmount: 75_000 });

    await runSettlePhase({ currency: 'NGN', mode: 'live', now: FAR_FUTURE });
    const availableBatch = await runMakeAvailablePhase({ currency: 'NGN', mode: 'live', now: FAR_FUTURE });

    expect(availableBatch.transactionCount).toBe(1);
    expect(availableBatch.totalAmount).toBe(75_000);
    expect(availableBatch.mode).toBe('live');

    const wallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'live' });
    expect(wallet.balance).toBe(75_000);

    // The test-mode wallet for the same merchant must not have been
    // touched by a live-mode settlement run.
    const testWallet = await Wallet.findOne({ merchant: merchant._id, currency: 'NGN', mode: 'test' });
    expect(testWallet).toBeNull();
  });
});
