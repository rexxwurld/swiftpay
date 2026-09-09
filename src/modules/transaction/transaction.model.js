// src/modules/transaction/transaction.model.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true },
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', required: true },

    // Copied from the virtual account this payment landed on. Every
    // downstream money movement for this transaction (settlement,
    // refunds, disputes) reads mode from here rather than re-deriving it.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live', index: true },

    amountExpected: { type: Number, default: null },
    amountReceived: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },

    status: {
      type: String,
      enum: ['pending', 'success', 'partial', 'over', 'failed', 'flagged'],
      default: 'pending',
    },
    flagReason: { type: String, default: null },

    settlementStatus: {
      type: String,
      enum: ['pending_settlement', 'settled', 'available'],
      default: null,
    },
    settledAt: { type: Date, default: null },
    availableAt: { type: Date, default: null },
    settlementBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'SettlementBatch', default: null },
  settlementLockId: {
  type: mongoose.Schema.Types.ObjectId,
  default: null,
  index: true,
},

settlementLockPhase: {
  type: String,
  enum: ['settle', 'make_available', null],
  default: null,
},

settlementLockAt: {
  type: Date,
  default: null,
},
    channel: { type: String, default: 'dedicated_virtual_account' },
    bankReference: { type: String },

    splitSubaccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Subaccount', default: null },
    splitAmount: { type: Number, default: 0 },

    platformFee: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },

    // Running total of everything reserved/paid out against this
    // transaction via refund.service.js. This is the single source of
    // truth for "how much of this payment is still refundable" - it is
    // only ever changed through the atomic findOneAndUpdate guard in
    // requestRefund/reverseRefund (see refund.service.js), never read
    // then written separately. That guard is what actually prevents two
    // concurrent refund requests from together refunding more than
    // amountReceived; previously this was computed by summing prior
    // Refund documents outside the transaction session, which left a
    // race window between two concurrent requests.
    refundedAmount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

transactionSchema.index({ settlementStatus: 1, createdAt: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
