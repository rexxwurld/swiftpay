// scripts/fetch-and-reconcile.js
//
// Automates what used to be a manual two-step process:
//   1. Fetch RexxPay Bank's confirmed-deposit export for a date range
//      (GET /api/v1/admin/settlement-export?from=&to=)
//   2. Reconcile it against our own records (scripts/reconcile.js's logic)
//
// Previously this wrote the export to a temp file and shelled out to
// `node scripts/reconcile.js <tempfile>` as a child process - which is
// how admin.routes.js's /cron/fetch-and-reconcile route ended up spawning
// a `node` process from inside an HTTP handler. Now fetchAndReconcile()
// below calls the reconciliation logic directly, in-process, so nothing
// here ever spawns a child process or touches the filesystem.
//
// Usage:
//   node scripts/fetch-and-reconcile.js                # last 24 hours
//   node scripts/fetch-and-reconcile.js 2026-08-16 2026-08-17

require('dotenv').config();
const axios = require('axios');
const { rexxPayBankBaseUrl, rexxPayBankAdminKey } = require('../src/config/env');
const { runReconciliation, hasDiscrepancies } = require('./reconcile');

async function fetchSettlementExport(from, to) {
  if (!rexxPayBankBaseUrl || !rexxPayBankAdminKey) {
    throw new Error(
      'REXXPAY_BANK_BASE_URL and REXXPAY_BANK_ADMIN_KEY must be set to fetch the settlement export'
    );
  }

  const res = await axios.get(`${rexxPayBankBaseUrl}/api/v1/admin/settlement-export`, {
    headers: { 'x-admin-key': rexxPayBankAdminKey },
    params: { from, to },
    timeout: 30000,
  });

  if (!res.data || res.data.status !== true) {
    throw new Error(`unexpected response from settlement-export: ${JSON.stringify(res.data)}`);
  }

  return res.data.data; // array already shaped for reconcile.js
}

// The reusable piece. Assumes an active mongoose connection already
// exists (same contract as runReconciliation) - the CLI entry point below
// opens one; admin.routes.js's route reuses the app's own connection.
async function fetchAndReconcile({ from, to } = {}) {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);

  const rows = await fetchSettlementExport(fromDate.toISOString(), toDate.toISOString());
  const report = await runReconciliation(rows);

  return { from: fromDate.toISOString(), to: toDate.toISOString(), rowsFetched: rows.length, report };
}

module.exports = { fetchAndReconcile };

// CLI entry point only - runs when this file is executed directly, not
// when required as a module by admin.routes.js. Behavior for anyone
// running this by hand is unchanged from before (aside from no longer
// writing/deleting a temp file, which was never user-visible anyway).
if (require.main === module) {
  const mongoose = require('mongoose');
  const { mongoUri } = require('../src/config/env');
  const [, , fromArg, toArg] = process.argv;

  (async () => {
    await mongoose.connect(mongoUri);
    try {
      console.log('[fetch-and-reconcile] pulling settlement export...');
      const { rowsFetched, report } = await fetchAndReconcile({ from: fromArg, to: toArg });
      console.log(`[fetch-and-reconcile] received ${rowsFetched} settled deposit(s) from RexxPay Bank`);
      console.log(JSON.stringify(report, null, 2));

      if (hasDiscrepancies(report)) {
        console.error('\n[fetch-and-reconcile] discrepancy(ies) found - needs manual review.');
        process.exitCode = 1;
      } else {
        console.log('\n[fetch-and-reconcile] clean - no discrepancies.');
      }
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error('[fetch-and-reconcile] failed:', err.message);
    process.exit(1);
  });
}
