// src/modules/cron/cronLock.model.js
//
// A minimal distributed lock backed by a unique _id, so it works across
// multiple app instances without needing Redis or anything else new.
// TTL index is a safety net only (auto-cleans a lock left behind by a
// crashed process) - normal release happens explicitly in cronLock.js.

const mongoose = require('mongoose');

const cronLockSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // the lock name, e.g. 'pool-provisioning'
  acquiredAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
});

cronLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('CronLock', cronLockSchema);
