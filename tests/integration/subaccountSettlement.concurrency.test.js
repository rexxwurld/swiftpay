// tests/integration/subaccountSettlement.concurrency.test.js
//
// Regression test for the audit report's Critical #2: two simultaneous
// settleSubaccount() calls for the same subaccount used to both read the
// same not-yet-debited ledger balance and both create a full settlement
// for it - draining twice as much money as the subaccount actually held.
//
// The fix (see subaccount.service.js) is a $inc write on the Subaccount
// document, done INSIDE the same Mongo transaction as the balance read -
// which only actually proves anything under real multi-document
// transaction semantics, hence this being an integration test against a
// real (in-memory) replica set rather than a mocked model.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant, Subaccount, SubaccountSettlement, LedgerEntry;
let createSubaccount, settleSubaccount;
let postDoubleEntry;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Subaccount = require('../../src/modules/subaccount/subaccount.model');
  SubaccountSettlement = require('../../src/modules/subaccount/subaccountSettlement.model');
  LedgerEntry = require('../../src/modules/ledger/ledger.model');

  ({ createSubaccount, settleSubaccount } = require('../../src/modules/subaccount/subaccount.service'));
  ({ postDoubleEntry } = require('../../src/modules/ledger/ledger.service'));
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
    ...overrides,
  });
}

async function creditSubaccount(subaccountId, amount, { currency = 'NGN', mode = 'test' } = {}) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await postDoubleEntry({
        entryGroup: `test_credit_${new mongoose.Types.ObjectId()}`,
        amount,
        currency,
        mode,
        sourceType: 'adjustment',
        sourceRef: new mongoose.Types.ObjectId().toString(),
        debit: { accountType: 'suspense', accountRef: 'test_funding_source', description: 'test fixture' },
        credit: { accountType: 'subaccount_settlement', accountRef: subaccountId.toString(), description: 'test fixture' },
        session,
      });
    });
  } finally {
    session.endSession();
  }
}

describe('settleSubaccount concurrency', () => {
  it('never settles the same balance twice under concurrent requests', async () => {
    const merchant = await makeMerchant();
    const subaccount = await createSubaccount({
      merchantId: merchant._id,
      businessName: 'Sub Merchant',
      settlementBankCode: '044',
      settlementAccountNumber: '0123456789', // does NOT end in '0000' - avoids the simulator's decline path
      settlementAccountName: 'Sub Merchant Ltd',
    });

    const originalBalance = 100_000; // ₦1,000.00 in minor units
    await creditSubaccount(subaccount._id, originalBalance);

    // Fire two settlement requests at the same time - this is the actual
    // race. Both will call getBalance() and see the same ₦1,000 before
    // either has debited anything.
    const results = await Promise.allSettled([
      settleSubaccount({ merchantId: merchant._id, subaccountId: subaccount._id }),
      settleSubaccount({ merchantId: merchant._id, subaccountId: subaccount._id }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one of the two concurrent calls should have won the race.
    // The loser re-reads the balance inside its own transaction (after
    // losing the write-conflict retry) and correctly finds nothing left
    // to settle.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('no_balance_to_settle');

    // The critical assertion: total money actually settled equals the
    // original balance EXACTLY - not double it.
    const settlements = await SubaccountSettlement.find({ subaccount: subaccount._id });
    const totalSettled = settlements.reduce((sum, s) => sum + s.amount, 0);
    expect(totalSettled).toBe(originalBalance);
    expect(settlements).toHaveLength(1);

    // And the ledger should now show a net-zero balance for this
    // subaccount, not a negative one (which would mean it was
    // over-debited).
    const remainingCredits = await LedgerEntry.aggregate([
      { $match: { accountRef: subaccount._id.toString(), accountType: 'subaccount_settlement' } },
      { $group: { _id: null, credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } }, debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } } } },
    ]);
    const netBalance = remainingCredits[0].credits - remainingCredits[0].debits;
    expect(netBalance).toBe(0);
  });

  it('settles cleanly with no concurrency (sanity check)', async () => {
    const merchant = await makeMerchant();
    const subaccount = await createSubaccount({
      merchantId: merchant._id,
      businessName: 'Sub Merchant 2',
      settlementBankCode: '044',
      settlementAccountNumber: '0987654321',
      settlementAccountName: 'Sub Merchant 2 Ltd',
    });

    await creditSubaccount(subaccount._id, 50_000);

    const [settlement] = await settleSubaccount({ merchantId: merchant._id, subaccountId: subaccount._id });
    expect(settlement.amount).toBe(50_000);
    expect(['successful', 'processing']).toContain(settlement.status);

    await expect(
      settleSubaccount({ merchantId: merchant._id, subaccountId: subaccount._id })
    ).rejects.toThrow('no_balance_to_settle');
  });
});
