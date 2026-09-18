// scripts/release-stale-accounts.js
//
// Every virtual account is now single-use per order/deposit request - it
// gets handed back to the pool automatically the moment a payment is
// recorded against it (see transaction.service.js). But if a customer
// abandons checkout and never pays at all, that account stays stuck in
// 'assigned' state forever unless something sweeps it.
//
// This script releases any account that's been 'assigned' for longer than
// limits.VIRTUAL_ACCOUNT_EXPIRY_MINUTES with no payment ever landing on it,
// returning it to the available pool.
//
// Usage:
//   node scripts/release-stale-accounts.js
//
// Intended to run on a schedule (cron every 5-15 minutes, or a scheduled
// task on whatever host runs this service).

require('dotenv').config();
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');
const limits = require('../src/config/limits');
const { releaseStaleAssignedAccounts } = require('../src/modules/virtualAccount/virtualAccount.service');

async function run() {
  await mongoose.connect(mongoUri);

  const released = await releaseStaleAssignedAccounts(limits.VIRTUAL_ACCOUNT_EXPIRY_MINUTES);

  console.log(
    `[release-stale-accounts] released ${released} account(s) assigned longer than ${limits.VIRTUAL_ACCOUNT_EXPIRY_MINUTES} minute(s) with no payment.`
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[release-stale-accounts] failed:', err);
  process.exit(1);
});
