// scripts/auto-provision-pool.js
//
// Automatic Pool Manager. Checks every bank partner's available-account
// count and tops it up if it's at or below limits.POOL_MIN_THRESHOLD, so
// customers never have to wait on someone opening the admin dashboard.
// The manual /admin/provision-pool route still exists for exceptions and
// one-off intervention - this script is the routine, unattended path.
//
// Usage:
//   node scripts/auto-provision-pool.js [threshold] [topUpCount]
//
// Intended to run on a schedule (cron every 5-15 minutes, or a scheduled
// task on whatever host runs this service) - same pattern as
// release-stale-accounts.js and reconcile.js.

require('dotenv').config();
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');
const limits = require('../src/config/limits');
const {
  ensureDefaultBankPartners,
  maintainAccountPools,
} = require('../src/modules/bankPartner/bankPartner.service');

const threshold = process.argv[2] ? parseInt(process.argv[2], 10) : limits.POOL_MIN_THRESHOLD;
const topUpCount = process.argv[3] ? parseInt(process.argv[3], 10) : limits.POOL_TOPUP_COUNT;

async function run() {
  await mongoose.connect(mongoUri);
  await ensureDefaultBankPartners();

  const results = await maintainAccountPools({ threshold, topUpCount });

  for (const r of results) {
    if (r.action === 'provisioned') {
      console.log(
        `[auto-provision-pool] ${r.bank}: ${r.availableBefore} <= ${r.threshold} -> provisioned ${r.provisioned}, now ${r.availableAfter}.`
      );
    } else if (r.action === 'failed') {
      console.error(`[auto-provision-pool] ${r.bank}: FAILED to top up (${r.availableBefore} <= ${r.threshold}) - ${r.error}`);
    } else {
      console.log(`[auto-provision-pool] ${r.bank}: ${r.availableBefore} > ${r.threshold}, no action needed.`);
    }
  }

  const failed = results.some((r) => r.action === 'failed');

  await mongoose.disconnect();
  process.exitCode = failed ? 1 : 0;
}

run().catch((err) => {
  console.error('[auto-provision-pool] failed:', err);
  process.exit(1);
});
