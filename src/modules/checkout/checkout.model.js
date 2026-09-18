const mongoose = require('mongoose');

const checkoutSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', required: true },

    // A merchant's tx_ref must behave like an idempotency key for
    // initialization: the same (merchant, mode, txRef) can only ever
    // back ONE checkout/virtual-account/transaction. Without this,
    // the same reference could be reused for two unrelated payments,
    // and the second bank transfer would be silently treated as a
    // duplicate of the first (see audit report, Critical #8).
    txRef: { type: String, required: true },
    accountNumber: { type: String, required: true },
    bankName: { type: String, default: null },
    amountExpected: { type: Number, default: null },
    redirectUrl: { type: String, default: null },

    // Copied from the virtual account at creation time - lets the
    // checkout page/dashboard clearly mark this as a test transaction.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },

    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// Enforce the idempotency guarantee at the database level, not just in
// application code, so a race between two concurrent initialize() calls
// can't both win. Scoped by mode too, since test/live are independent
// reference spaces.
checkoutSchema.index({ merchant: 1, mode: 1, txRef: 1 }, { unique: true });

module.exports = mongoose.model('Checkout', checkoutSchema);
