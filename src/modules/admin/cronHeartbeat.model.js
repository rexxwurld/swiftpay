// src/modules/admin/cronHeartbeat.model.js
// One document per cron job name (e.g. "run-settlement"). Updated every
// time that job's route is hit, whether it succeeded or failed - a
// failure still proves the scheduler is firing, which is what this
// exists to detect. Used by GET /api/admin/cron/health to answer
// "is anything supposed to be running on a schedule NOT running?"
// without waiting for a pile of stuck payments to notice for you.

const mongoose = require('mongoose');

const cronHeartbeatSchema = new mongoose.Schema(
  {
    jobName: { type: String, required: true, unique: true },
    lastRunAt: { type: Date, required: true },
    lastStatus: { type: String, enum: ['ok', 'error'], required: true },
    lastError: { type: String },
  },
  { timestamps: true }
);

async function recordHeartbeat(jobName, ok, errorMessage = null) {
  await mongoose.model('CronHeartbeat').findOneAndUpdate(
    { jobName },
    {
      $set: {
        lastRunAt: new Date(),
        lastStatus: ok ? 'ok' : 'error',
        lastError: ok ? null : errorMessage,
      },
    },
    { upsert: true }
  );
}

const CronHeartbeat = mongoose.model('CronHeartbeat', cronHeartbeatSchema);

module.exports = { CronHeartbeat, recordHeartbeat };
