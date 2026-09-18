// tests/integration/reconcile.test.js
//
// scripts/reconcile.js had no test coverage before this file. Covers the
// mode-isolation fix from the Sep 2026 transfer-only audit: a bank
// settlement export only ever lists real transfers, so comparing it
// against ALL transactions (test-mode included) made every successful
// test-mode transaction a permanent false-positive "in ours, not in
// bank" discrepancy.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('../../tests/integration/setup');
const { runReconciliation } = require('../../scripts/reconcile');

jest.setTimeout(30000);

let Transaction;

beforeAll(async () => {
  await startTestDb();
  Transaction = require('../../src/modules/transaction/transaction.model');
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

async function makeTransaction({ mode, status, bankReference, amountReceived }) {
  return Transaction.create({
    reference: `ref_${new mongoose.Types.ObjectId()}`,
    merchant: new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    virtualAccount: new mongoose.Types.ObjectId(),
    mode,
    amountReceived,
    netAmount: amountReceived,
    currency: 'NGN',
    status,
    bankReference,
  });
}

describe('scripts/reconcile.js mode isolation', () => {
  it('does not flag a successful test-mode transaction as missing from the bank export', async () => {
    await makeTransaction({ mode: 'test', status: 'success', bankReference: 'test-bref-1', amountReceived: 100_000 });

    // Empty bank export - a real one would never mention this reference
    // either, since it never touched a real bank at all.
    const report = await runReconciliation([]);

    expect(report.inOursNotInBank).toHaveLength(0);
    expect(report.totals.ourTransactions).toBe(0); // filtered out by mode:'live' default
  });

  it('still flags a live-mode transaction the bank export does not have', async () => {
    await makeTransaction({ mode: 'live', status: 'success', bankReference: 'live-bref-1', amountReceived: 100_000 });

    const report = await runReconciliation([]);

    expect(report.inOursNotInBank).toHaveLength(1);
    expect(report.inOursNotInBank[0].bankReference).toBe('live-bref-1');
  });

  it('detects an amount mismatch between our record and the bank export', async () => {
    await makeTransaction({ mode: 'live', status: 'success', bankReference: 'live-bref-2', amountReceived: 100_000 });

    const report = await runReconciliation([
      { bankReference: 'live-bref-2', amount: 90_000, settledAt: new Date().toISOString() },
    ]);

    expect(report.amountMismatches).toHaveLength(1);
    expect(report.amountMismatches[0]).toMatchObject({ ourAmount: 100_000, bankAmount: 90_000 });
  });
});
