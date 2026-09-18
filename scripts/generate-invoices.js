// scripts/generate-invoices.js
//
// Billing sweep for subscriptions. Two jobs, run together:
//   1. generateDueInvoices()  - creates an Invoice (+ a virtual account
//      the customer pays into) for every subscription whose
//      nextBillingDate has arrived.
//   2. markOverdueInvoices()  - flags any invoice that passed its due
//      date without being paid, and moves its subscription to past_due.
//
// Usage:
//   node scripts/generate-invoices.js
//
// Intended to run on a schedule (cron once daily is enough for
// daily/weekly/monthly/yearly plans - the sweep is idempotent per cycle
// thanks to the (subscription, periodStart) unique index on Invoice, so
// running it more often than needed is harmless).

require('dotenv').config();
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');
const { generateDueInvoices, markOverdueInvoices } = require('../src/modules/subscription/subscription.service');

async function run() {
  await mongoose.connect(mongoUri);

  const invoices = await generateDueInvoices();
  console.log(`[generate-invoices] generated/confirmed ${invoices.length} invoice(s) for due subscriptions.`);

  const overdueCount = await markOverdueInvoices();
  console.log(`[generate-invoices] marked ${overdueCount} invoice(s) as failed/overdue.`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[generate-invoices] failed:', err);
  process.exit(1);
});
