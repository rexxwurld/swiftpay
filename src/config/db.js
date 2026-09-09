// src/config/db.js
const mongoose = require('mongoose');

// The Wallet collection used to be uniquely indexed on just
// (merchant, currency) before `mode` (test/live) was added. Mongoose
// does not drop old indexes automatically when a schema changes, so
// wallet.model.js's comment asks a human to run
// `db.wallets.dropIndex('merchant_1_currency_1')` manually after
// deploying. If that step is ever skipped, nothing fails immediately -
// the app boots fine, and the stale index only causes a confusing
// duplicate-key error the first time a merchant's test-mode wallet
// collides with their live-mode wallet under the old, too-narrow index.
//
// Instead of relying on that manual step being remembered, check for the
// stale index every time the app connects, and drop it automatically if
// found - logging loudly either way so this is never a silent event.
async function cleanUpStaleWalletIndex() {
  const STALE_INDEX_NAME = 'merchant_1_currency_1';

  try {
    const collection = mongoose.connection.collection('wallets');
    const indexes = await collection.indexes();
    const staleIndex = indexes.find((idx) => idx.name === STALE_INDEX_NAME);

    if (staleIndex) {
      console.warn(
        `[db] found stale Wallet index "${STALE_INDEX_NAME}" (pre-dates the "mode" field) - dropping it automatically.`
      );
      await collection.dropIndex(STALE_INDEX_NAME);
      console.warn(`[db] dropped stale Wallet index "${STALE_INDEX_NAME}".`);
    }
  } catch (err) {
    // Don't crash the app over this - just make it impossible to miss.
    // The correct (merchant, currency, mode) index still gets created by
    // Mongoose separately; this only cleans up the leftover old one.
    console.error(
      '[db] failed to check/drop stale Wallet index - if wallet creation later fails with a duplicate-key error on (merchant, currency), run `db.wallets.dropIndex("merchant_1_currency_1")` manually.',
      err.message
    );
  }
}

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set in .env');
  }
  await mongoose.connect(uri);
  console.log('[db] connected to MongoDB');

  await cleanUpStaleWalletIndex();
}

module.exports = connectDB;
