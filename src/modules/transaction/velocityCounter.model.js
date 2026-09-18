// src/modules/transaction/velocityCounter.model.js
//
// One row per (virtualAccount, windowKey). Same idea as
// dailyLimitCounter.model.js, but for the velocity guard (catching rapid
// repeat payments to the same account - a structuring/smurfing pattern).
//
// windowKey identifies a fixed time slice (e.g. "this particular
// 10-minute window"), so this is a fixed-window counter rather than a
// perfectly rolling one. That's a deliberate simplification: a fixed
// window is trivial to make atomic (one $inc, one check), while a true
// rolling window would need a more complex sliding-log structure. For a
// fraud guard like this, a fixed window is a normal, accepted trade-off -
// it catches the same rapid-repeat pattern, just measured in clean
// windows instead of a continuously sliding one.

const mongoose = require('mongoose');

const velocityCounterSchema = new mongoose.Schema(
  {
    virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', required: true },
    windowKey: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

velocityCounterSchema.index({ virtualAccount: 1, windowKey: 1 }, { unique: true });

module.exports = mongoose.model('VelocityCounter', velocityCounterSchema);
