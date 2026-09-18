// scripts/create-admin-user.js
//
// Bootstraps a named admin account (see src/modules/admin/adminUser.model.js
// for why these exist). Deliberately a CLI script, not an HTTP endpoint -
// creating an admin account is a "someone with direct server/DB access
// did this on purpose" action, not something that should ever be
// reachable over the network, even behind the admin key.
//
// Usage:
//   node scripts/create-admin-user.js <email> <role> [password]
//
//   role must be one of: superadmin, finance, support
//   If password is omitted, a random one is generated and printed once -
//   it is never stored anywhere except the hash in the database.
//
// Example:
//   node scripts/create-admin-user.js ops@swiftpay.example finance

const mongoose = require('mongoose');
const crypto = require('crypto');
const { mongoUri } = require('../src/config/env');
const { createAdminUser } = require('../src/modules/admin/adminAuth.service');

async function main() {
  const [, , email, role, providedPassword] = process.argv;

  if (!email || !role) {
    console.error('Usage: node scripts/create-admin-user.js <email> <role> [password]');
    console.error('  role: superadmin | finance | support');
    process.exit(1);
  }

  const password = providedPassword || crypto.randomBytes(18).toString('base64url');

  await mongoose.connect(mongoUri);

  try {
    const admin = await createAdminUser({ email, password, role });
    console.log(`Created admin user: ${admin.email} (${admin.role})`);
    if (!providedPassword) {
      console.log('\nGenerated password (shown once, store it somewhere safe - e.g. a password manager):');
      console.log(password);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('[create-admin-user] failed:', err.message);
  process.exit(1);
});
