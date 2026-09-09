// src/modules/transaction/dailyLimitCounter.model.js
//
// One row per (merchant, currency, dayKey). Used to atomically track how
// much a merchant has received today, so the daily-inbound-limit check in
// transaction.service.js can't be bypassed by two payments landing at the
// exact same moment - each payment atomically increments this counter and
// checks the RESULT of its own increment, instead of reading a total and
// deciding separately (which is what could race before this).
//
// dayKey is a plain 'YYYY-MM-DD' string (UTC), so a new row starts fresh
// every day automatically - nothing needs to reset or clean these up for
// the limit check itself to work correctly.

const mongoose = require('mongoose');

const dailyLimitCounterSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    currency: { type: String, required: true },
    dayKey: { type: String, required: true },
    totalReceived: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

dailyLimitCounterSchema.index({ merchant: 1, currency: 1, dayKey: 1 }, { unique: true });

module.exports = mongoose.model('DailyLimitCounter', dailyLimitCounterSchema);
