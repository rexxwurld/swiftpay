// src/modules/refund/refund.model.js
const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    reference: { type: String, required: true, unique: true },

    // Caller-supplied (body.idempotencyKey or an Idempotency-Key header),
    // same convention as payout.model.js. Lets a merchant safely retry an
    // identical refund request (browser retry, network timeout, worker
    // restart) without risking a second real refund - see requestRefund()
    // in refund.service.js, which checks this before creating anything.
    idempotencyKey: { type: String, default: null },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },
    reason: { type: String, default: null },

    // Copied from the original transaction. Needed at reversal time,
    // when only the Refund doc (not the Transaction) is loaded.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },

    destinationBankCode: { type: String, required: true },
    destinationAccountNumber: { type: String, required: true },
    destinationAccountName: { type: String, required: true },

    // 'pending'    - not yet submitted to the bank (shouldn't normally be
    //                observed externally; exists briefly mid-request).
    // 'submitted'  - bank has acknowledged receipt of the refund
    //                instruction. This is what a merchant sees right
    //                after calling POST /refunds - it does NOT mean the
    //                money has moved yet.
    // 'reversing'  - a real, persisted lock state: something (a failed
    //                submission, an outright bank rejection, or the
    //                async decline webhook) has decided this refund must
    //                be reversed, and reverseRefund() is/was mid-flight.
    //                Only one caller can ever win the
    //                pending/submitted -> reversing transition (it's an
    //                atomic findOneAndUpdate), so this is what actually
    //                makes reversal idempotent under concurrent or
    //                retried webhook deliveries - not just a status
    //                check, an atomic compare-and-swap on this field.
    // 'successful' - bank's async webhook confirmed the refund landed.
    // 'failed'     - reserved for a future distinct "we tried to reverse
    //                and that itself failed" state; not set by the
    //                current code path, kept for forward compatibility
    //                with monitoring/alerting.
    // 'reversed'   - claimed refund headroom + debited wallet amount
    //                were given back because submission or confirmation
    //                failed.
    status: {
      type: String,
      enum: ['pending', 'submitted', 'reversing', 'successful', 'failed', 'reversed'],
      default: 'pending',
    },
    failureReason: { type: String },

    // Bank's acknowledgement reference for the *submission* (from
    // sendRefundInstruction/simulateRefundInstruction). Not proof of
    // settlement - just proof the instruction was received.
    submissionRef: { type: String, default: null },
    submittedAt: { type: Date, default: null },

    // Bank's reference for the *final, confirmed* outcome, delivered via
    // the async refund webhook. This is what actually proves the refund
    // completed (or was declined).
    providerRef: { type: String, default: null },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Partial unique index (only applies when idempotencyKey is an actual
// string) - identical shape to payout.model.js's index on the same
// three fields, and for the same reason: two refund requests for the
// same merchant+key+mode can never both create a document, even if they
// race each other, so this is what a duplicate-key error (code 11000)
// in requestRefund() actually means.
refundSchema.index(
  { merchant: 1, idempotencyKey: 1, mode: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Refund', refundSchema);
