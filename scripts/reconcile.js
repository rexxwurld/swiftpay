// scripts/reconcile.js
//
// Real payment processors don't just trust their own webhook-driven state
// forever - the bank/BaaS partner sends a periodic (usually daily)
// settlement file listing everything that ACTUALLY cleared on their side.
// This script compares that file against our own Transaction records and
// surfaces mismatches: things we think succeeded that the bank doesn't
// have, and things the bank settled that we never recorded. Both are bugs
// (or fraud) waiting to be found before a customer or auditor finds them
// for you.
//
// Usage:
//   node scripts/reconcile.js path/to/bank-settlement-file.json
//
// Expected settlement file format (this is what a real BaaS partner's
// export would look like, simplified):
//   [
//     { "bankReference": "bnk_abc123", "accountNumber": "9012345678", "amount": 500000, "settledAt": "2026-08-08T10:00:00Z" },
//     ...
//   ]

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');
const Transaction = require('../src/modules/transaction/transaction.model');

// The actual comparison logic - pure, no file I/O, no DB connect/disconnect
// of its own. Assumes the caller already has an active mongoose connection
// (the CLI entry point below connects/disconnects around it; the admin
// route in admin.routes.js reuses the app's own already-open connection
// instead of opening a second one).
//
// IMPORTANT: `settledRecords` is normally an export covering a specific
// window (e.g. "yesterday"), not the bank's entire history. Comparing it
// against ALL of our transactions ever recorded - instead of the same
// window - means every transaction from before the export starts looks
// like "in ours, not in bank", a false discrepancy on every single run
// (see audit report, High #19). `rangeBufferHours` widens the window on
// both sides to absorb clock/timing skew between when we recorded a
// transaction and when the bank says it settled.
async function runReconciliation(settledRecords, { rangeBufferHours = 24, mode = 'live' } = {}) {
  const settledRefs = new Set(settledRecords.map((r) => r.bankReference));
  const settledByRef = new Map(settledRecords.map((r) => [r.bankReference, r]));

  // A bank settlement export only ever covers real transfers - test-mode
  // transactions never touch RexxPay Bank at all (see VirtualAccount.mode).
  // Without this filter, every successful test-mode transaction would
  // permanently show up as "in ours, not in bank" on every single run -
  // the same class of false-positive this function already had to fix
  // once before for date range (see High #19 above).
  const query = { status: { $in: ['success', 'partial', 'over'] }, mode };

  const settledDates = settledRecords
    .map((r) => (r.settledAt ? new Date(r.settledAt) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()));

  if (settledDates.length) {
    const bufferMs = rangeBufferHours * 60 * 60 * 1000;
    const rangeStart = new Date(Math.min(...settledDates) - bufferMs);
    const rangeEnd = new Date(Math.max(...settledDates) + bufferMs);
    query.createdAt = { $gte: rangeStart, $lte: rangeEnd };
  }
  // If the settlement file has no parseable settledAt values at all, fall
  // back to comparing against full history rather than guessing a range -
  // better to over-report than to silently narrow on bad input.

  const ourTransactions = await Transaction.find(query).lean();
  const ourRefs = new Set(ourTransactions.map((t) => t.bankReference));

  const inOursNotInBank = ourTransactions.filter((t) => !settledRefs.has(t.bankReference));
  const inBankNotInOurs = settledRecords.filter((r) => !ourRefs.has(r.bankReference));

  const amountMismatches = ourTransactions
    .filter((t) => settledByRef.has(t.bankReference))
    .map((t) => ({ ours: t, bank: settledByRef.get(t.bankReference) }))
    .filter(({ ours, bank }) => ours.amountReceived !== bank.amount);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      ourTransactions: ourTransactions.length,
      bankSettlements: settledRecords.length,
      matched: ourTransactions.length - inOursNotInBank.length,
    },
    inOursNotInBank: inOursNotInBank.map((t) => ({ reference: t.reference, bankReference: t.bankReference, amountReceived: t.amountReceived })),
    inBankNotInOurs,
    amountMismatches: amountMismatches.map(({ ours, bank }) => ({
      bankReference: ours.bankReference,
      ourAmount: ours.amountReceived,
      bankAmount: bank.amount,
    })),
  };
}

function hasDiscrepancies(report) {
  return !!(report.inOursNotInBank.length || report.inBankNotInOurs.length || report.amountMismatches.length);
}

module.exports = { runReconciliation, hasDiscrepancies };

// CLI entry point only - runs when this file is executed directly
// (`node scripts/reconcile.js ...`), not when required as a module by
// fetch-and-reconcile.js or admin.routes.js. Behavior for anyone running
// this by hand is unchanged from before.
if (require.main === module) {
  (async () => {
    const filePath = process.argv[2];
    if (!filePath) {
      console.error('Usage: node scripts/reconcile.js <settlement-file.json>');
      process.exit(1);
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const settledRecords = JSON.parse(raw);

    await mongoose.connect(mongoUri);
    try {
      const report = await runReconciliation(settledRecords);
      console.log(JSON.stringify(report, null, 2));

      if (hasDiscrepancies(report)) {
        const total = report.inOursNotInBank.length + report.inBankNotInOurs.length + report.amountMismatches.length;
        console.error(`\n[reconcile] ${total} discrepancy(ies) found - needs manual review.`);
        process.exitCode = 1;
      } else {
        console.log('\n[reconcile] clean - no discrepancies.');
      }
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error('[reconcile] failed:', err);
    process.exit(1);
  });
}
