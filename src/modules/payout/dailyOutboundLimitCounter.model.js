// src/modules/payout/dailyOutboundLimitCounter.model.js
//
// One row per (merchant, currency, dayKey). Tracks combined daily
// PAYOUT + WITHDRAWAL volume for a merchant, atomically - same pattern
// as dailyLimitCounter.model.js (the inbound version). Shared between
// payout.service.js and withdrawal.service.js because both draw from
// the same wallet and both represent money leaving the platform - a
// merchant shouldn't be able to dodge the daily outbound cap just by
// splitting requests between the two endpoints.
//
// Note: this counts money REQUESTED to leave that day, not confirmed-
// successful transfers. If a payout is later reversed (bank declined
// it), this total is not decremented - a conservative choice, so a
// string of attempted-then-declined payouts still counts against the
// day's cap rather than silently freeing up more room to retry.

const mongoose = require('mongoose');

const dailyOutboundLimitCounterSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    currency: { type: String, required: true },
    dayKey: { type: String, required: true },
    totalSent: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

dailyOutboundLimitCounterSchema.index({ merchant: 1, currency: 1, dayKey: 1 }, { unique: true });

module.exports = mongoose.model('DailyOutboundLimitCounter', dailyOutboundLimitCounterSchema);
