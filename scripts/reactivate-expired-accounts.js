// scripts/reactivate-expired-accounts.js
//
// Accounts that were successfully used sit in 'deactivated' during their
// cooldown window (see ACCOUNT_COOLDOWN_MINUTES in virtualAccount.service.js)
// before they're allowed back into the available pool. Nothing flips
// deactivated -> available on its own - this script does that, for every
// account whose cooldownUntil has passed.
//
// Usage:
//   node scripts/reactivate-expired-accounts.js
//
// Intended to run on a schedule (cron every 5-15 minutes) - same pattern
// as release-stale-accounts.js.

require('dotenv').config();
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');
const { reactivateExpiredAccounts } = require('../src/modules/virtualAccount/virtualAccount.service');

async function run() {
  await mongoose.connect(mongoUri);

  const reactivated = await reactivateExpiredAccounts();

  console.log(
    `[reactivate-expired-accounts] reactivated ${reactivated} account(s) whose cooldown expired.`
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[reactivate-expired-accounts] failed:', err);
  process.exit(1);
});
