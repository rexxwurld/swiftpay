// src/modules/subaccount/subaccountSettlement.model.js
//
// Mirrors Payout, but drains a Subaccount's accrued ledger balance
// instead of a Merchant's wallet. Created when the parent merchant
// settles a subaccount out to its bank account.

const mongoose = require('mongoose');

const subaccountSettlementSchema = new mongoose.Schema(
  {
    subaccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Subaccount', required: true },
    parentMerchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    reference: { type: String, required: true, unique: true },

    amount: { type: Number, required: true }, // minor units
    currency: { type: String, required: true, default: 'NGN' },
    mode: {
  type: String,
  enum: ['test', 'live'],
  required: true,
  default: 'live',
},

    status: {
      type: String,
      enum: ['pending', 'processing', 'successful', 'failed', 'reversed', 'ambiguous'],
      default: 'pending',
    },
    failureReason: { type: String },
    providerRef: { type: String, default: null },
  },
  { timestamps: true }
);
// Only one settlement may be actively processing for a subaccount at a time.
// This is the database-level concurrency guard: two simultaneous settlement
// requests cannot both reserve the same subaccount balance.
subaccountSettlementSchema.index(
  { subaccount: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'processing' },
  }
);
module.exports = mongoose.model('SubaccountSettlement', subaccountSettlementSchema);
