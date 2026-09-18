// src/modules/dispute/dispute.model.js
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');

const evidenceSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    url: { type: String },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    disputeCode: { type: String, required: true, unique: true, default: () => `dp_${nanoid(12)}` },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },

    // Copied from the original transaction. Needed at resolution time,
    // when only the Dispute doc (not the Transaction) is loaded.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },

    reason: {
      type: String,
      enum: ['fraudulent', 'duplicate', 'product_not_received', 'product_unacceptable', 'unrecognized', 'other'],
      default: 'other',
    },
    reasonDetail: { type: String },

    status: {
      type: String,
      enum: ['open', 'under_review', 'resolving', 'won', 'lost'],
      default: 'open',
    },

    // Present (and true) only while status is 'open' or 'under_review';
    // unset the moment a dispute resolves. Combined with the partial
    // unique index below, this is what actually stops a transaction
    // from having more than one *open* dispute at a time - a status
    // check alone in openDispute() can't do this safely, because two
    // concurrent openDispute() calls could both read "no open dispute
    // exists yet" before either has written its own. A partial unique
    // index is enforced by MongoDB itself at insert time, so the second
    // concurrent insert fails with a duplicate-key error instead of
    // silently succeeding. Once a dispute resolves (won/lost) and this
    // field is unset, the transaction is free to be disputed again in
    // the future - this only ever blocks a second *simultaneously open*
    // dispute, not a second dispute ever.
    openLock: { type: Boolean, default: true },

    evidence: { type: [evidenceSchema], default: [] },
    evidenceDueBy: { type: Date, required: true },

    resolution: { type: String },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

disputeSchema.index({ merchant: 1, status: 1 });

// Partial unique index: only applies to documents where openLock is
// true, so it enforces "at most one open dispute per transaction"
// without blocking a transaction from ever being disputed again after
// an earlier dispute resolves.
disputeSchema.index(
  { transaction: 1, openLock: 1 },
  { unique: true, partialFilterExpression: { openLock: true } }
);

module.exports = mongoose.model('Dispute', disputeSchema);
