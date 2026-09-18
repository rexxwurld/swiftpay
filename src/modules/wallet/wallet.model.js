// src/modules/wallet/wallet.model.js
const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },

    balance: { type: Number, required: true, default: 0 }, // stored in minor units (kobo/cents)
    pendingSettlementBalance: { type: Number, required: true, default: 0 },
    reservedBalance: { type: Number, required: true, default: 0 },

    currency: { type: String, required: true, default: 'NGN' },

    // A merchant has a SEPARATE wallet per (currency, mode). Test and
    // live money must never sit in the same balance - a leaked test
    // key must never be able to touch a real balance, and a test
    // payout must never be able to drain real funds. Defaults to
    // 'live' so pre-existing wallets (created before this field
    // existed) are treated as real money, matching how they were
    // actually used.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },
  },
  { timestamps: true }
);

// IMPORTANT MANUAL STEP: this replaces the old { merchant, currency }
// unique index. Mongo will not auto-drop the old one - run once:
//   db.wallets.dropIndex('merchant_1_currency_1')
// after deploying, or Mongoose will throw a duplicate-index error.
walletSchema.index({ merchant: 1, currency: 1, mode: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);
