// src/modules/payout/payout.model.js
const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    reference: { type: String, required: true, unique: true },
    idempotencyKey: { type: String, default: null },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },

    // Which key authenticated this payout request. 'live' payouts call
    // the real RexxPay Bank; 'test' payouts never do (see
    // rexxPayBankClient.simulatePayoutInstruction). Required, no
    // default - requestPayout() refuses to create a Payout without an
    // explicit mode, so ambiguity here is a hard error, not a fallback.
    mode: { type: String, enum: ['test', 'live'], required: true },

    destinationBankCode: { type: String, required: true },
    destinationAccountNumber: { type: String, required: true },
    destinationAccountName: { type: String, required: true },

    status: {
      type: String,
      enum: ['pending', 'reserved', 'processing', 'finalizing', 'successful', 'failed', 'ambiguous', 'reversing', 'reversed'],
      default: 'pending',
    },
    failureReason: { type: String },
    providerRef: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

payoutSchema.index(
  { merchant: 1, idempotencyKey: 1, mode: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

payoutSchema.index({ providerRef: 1 }, { sparse: true });

module.exports = mongoose.model('Payout', payoutSchema);
