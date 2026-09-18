// src/utils/cronLock.js
//
// Two overlapping runs of a cron job (a slow run overlapping the next
// scheduled trigger, two app instances both hit the same cron endpoint,
// a manual run racing the scheduler) can both pass whatever "is there
// work to do" check the job starts with, and both do the work. For pool
// auto-provisioning specifically, that means both seeing the pool below
// threshold and both topping it up - doubling the top-up instead of
// applying it once (see audit report, Medium #27).
//
// This is a simple mutual-exclusion lock using nothing but a unique _id
// in Mongo, so it works across every instance talking to the same
// database without adding a new dependency (Redis, etc).

const CronLock = require('../modules/cron/cronLock.model');

/**
 * Runs `fn` only if the named lock can be acquired; otherwise returns
 * `{ skipped: true }` immediately without running `fn`. Releases the lock
 * when `fn` finishes (success or failure).
 *
 * @param {string} name - lock name, e.g. 'pool-provisioning'
 * @param {() => Promise<any>} fn
 * @param {number} ttlSeconds - safety-net expiry in case the process
 *   crashes mid-run and never releases the lock itself
 */
async function withCronLock(name, fn, ttlSeconds = 300) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  let acquired = false;

  try {
    // Try to create the lock document outright.
    await CronLock.create({ _id: name, acquiredAt: now, expiresAt });
    acquired = true;
  } catch (err) {
    if (err.code !== 11000) throw err;

    // A lock document already exists. Only take it over if it's expired
    // (the previous holder crashed without releasing it) - this is still
    // atomic: findOneAndUpdate's filter is checked and applied as one
    // operation, so two callers racing here can't both "win" the
    // takeover.
    const takenOver = await CronLock.findOneAndUpdate(
      { _id: name, expiresAt: { $lt: now } },
      { $set: { acquiredAt: now, expiresAt } },
      { new: true }
    );
    acquired = !!takenOver;
  }

  if (!acquired) {
    return { skipped: true, reason: 'lock_held' };
  }

  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    await CronLock.deleteOne({ _id: name }).catch(() => {
      // Not fatal - the TTL index will clean it up eventually, and
      // worst case a future run treats it as expired once expiresAt
      // passes.
    });
  }
}

module.exports = { withCronLock };
