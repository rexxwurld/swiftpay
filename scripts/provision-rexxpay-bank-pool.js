// scripts/provision-rexxpay-bank-pool.js
//
// Run this ONCE (and again only when the pool runs low) to create real
// wallets on RexxPay Bank for Infra's account pool:
//
//   node scripts/provision-rexxpay-bank-pool.js [count]
//
// Requires REXXPAY_BANK_ADMIN_KEY and MONGO_URI to be set in .env,
// same as running the server normally.

const connectDB = require('../src/config/db');
const { ensureDefaultBankPartners, provisionAccountPool } = require('../src/modules/bankPartner/bankPartner.service');

const count = parseInt(process.argv[2], 10) || 10;

async function run() {
  await connectDB();
  await ensureDefaultBankPartners();

  console.log(`Provisioning ${count} real account(s) from RexxPay Bank...`);
  await provisionAccountPool('rexxpay-bank', count);
  console.log('Done.');

  process.exit(0);
}

run().catch((err) => {
  console.error('Failed to provision RexxPay Bank pool:', err.message);
  process.exit(1);
});
