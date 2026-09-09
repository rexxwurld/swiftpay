// src/modules/ledger/ledger.model.js
//
// A wallet's `balance` field is just a cache. The LEDGER is the source of
// truth. Every movement of money writes TWO immutable rows here: one debit
// and one credit, tied together by `entryGroup`. The sum of all entries for
// any account, at any point in time, must always be reconstructable and
// must always net to zero across a transaction pair.
//
// This is what lets you (or an auditor, or the CBN) answer "where did this
// money come from and where did it go" without trusting a mutable balance
// field. Rows are never updated or deleted - only inserted. To reverse a
// mistake you post an opposite entry, you never edit history.

const mongoose = require('mongoose');

const ledgerEntrySchema = new mongoose.Schema(
  {
    // Groups the debit+credit pair (or larger fan-out) that make up one
    // economic event, e.g. one incoming payment or one payout.
    entryGroup: { type: String, required: true, index: true },

    // What kind of account this row moves money in/out of. Keeping this
    // as an enum (rather than assuming everything is a merchant wallet)
    // is what makes it possible to add new account types later - e.g. a
    // "platform_fee" or "suspense" account - without a schema change.
    accountType: {
      type: String,
      enum: ['merchant_wallet', 'platform_revenue', 'payout_clearing', 'subaccount_settlement', 'suspense'],
      required: true,
    },
    // For merchant_wallet entries, the Merchant _id. For platform-level
    // accounts this can be a fixed slug like "platform_revenue".
    accountRef: { type: String, required: true, index: true },

    direction: { type: String, enum: ['debit', 'credit'], required: true },
    amount: { type: Number, required: true }, // always positive, minor units
    currency: { type: String, required: true, default: 'NGN' },

    // What caused this entry, for traceability back to the source record.
    sourceType: {
      type: String,
      enum: ['incoming_payment', 'payout', 'withdrawal', 'refund', 'adjustment', 'reversal', 'settlement'],
      required: true,
    },
    sourceRef: { type: String, required: true }, // e.g. Transaction._id or Payout._id

    description: { type: String },
  },
  { timestamps: true }
);

// Never allow the same (sourceType, sourceRef, direction, accountRef) to be
// posted twice - this is the ledger's own idempotency guard, independent of
// whatever idempotency check happens upstream.
ledgerEntrySchema.index(
  { sourceType: 1, sourceRef: 1, accountRef: 1, direction: 1 },
  { unique: true }
);

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
