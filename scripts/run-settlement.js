// scripts/run-settlement.js
//
// Runs both settlement phases (pending_settlement -> settled ->
// available) for every currency the platform supports. Meant to be
// invoked on a schedule (cron, a scheduled Render job, etc.) - this is
// the piece the doc calls out under Reliability as
// "Cron/background settlement processing", which previously had nothing
// to run at all since the settlement module didn't exist.
//
// Usage:
//   node scripts/run-settlement.js
//   node scripts/run-settlement.js NGN USD   (restrict to specific currencies)

require('dotenv').config();
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');
const { SUPPORTED_CURRENCIES } = require('../src/config/currencies');
const { runSettlementCycle } = require('../src/modules/settlement/settlement.service');

async function main() {
  const requested = process.argv.slice(2);
  const currencies = requested.length ? requested.map((c) => c.toUpperCase()) : Object.keys(SUPPORTED_CURRENCIES);

  await mongoose.connect(mongoUri);

  const summary = [];
  for (const currency of currencies) {
    for (const mode of ['live', 'test']) {
      try {
        const { settleBatch, availableBatch } = await runSettlementCycle({ currency, mode });
        summary.push({
          currency,
          mode,
          settled: { count: settleBatch.transactionCount, amount: settleBatch.totalAmount, status: settleBatch.status },
          madeAvailable: { count: availableBatch.transactionCount, amount: availableBatch.totalAmount, status: availableBatch.status },
        });
      } catch (err) {
        summary.push({ currency, mode, error: err.message });
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  const anyFailed = summary.some(
    (s) => s.error || s.settled?.status === 'failed' || s.madeAvailable?.status === 'failed'
  );

  await mongoose.disconnect();
  process.exitCode = anyFailed ? 1 : 0;
}

main().catch((err) => {
  console.error('[run-settlement] failed:', err);
  process.exit(1);
});
