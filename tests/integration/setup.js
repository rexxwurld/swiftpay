// tests/integration/setup.js
//
// Several of the bugs this repo has had (subaccount double-settlement,
// duplicate tx_ref, idempotency races) only reproduce under REAL
// multi-document transaction semantics - a mocked Mongoose model can't
// show a write conflict, because there's no real storage engine
// underneath to conflict. These integration tests spin up a genuine
// MongoDB replica set in-memory (mongodb-memory-server) so
// `session.withTransaction()` behaves exactly like it would in
// production, including retrying on write conflicts.
//
// This is intentionally its own file (not a jest globalSetup) so each
// test file controls its own lifecycle and they can run with
// `--runInBand` without stepping on each other's replica set.

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

async function startTestDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  await mongoose.connect(uri);
}

async function stopTestDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

async function clearTestDb() {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

module.exports = { startTestDb, stopTestDb, clearTestDb };
