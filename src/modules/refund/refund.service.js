// src/modules/refund/refund.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const Refund = require('./refund.model');
const Transaction = require('../transaction/transaction.model');
const Merchant = require('../merchant/merchant.model');
const { debitWallet, creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { sendRefundInstruction, simulateRefundInstruction } = require('../bankPartner/rexxPayBankClient');
const { dispatchMerchantWebhook } = require('../../utils/merchantWebhook');
const auditLog = require('../audit/auditLog.service');

function toMajorUnits(amountMinorUnits) {
  return amountMinorUnits / 100;
}

// Merchant-facing entry point. In the real world, a refund is never
// confirmed in the same round trip that requests it - card refunds in
// particular settle over several business days via the network's batch
// process, and even bank-transfer refunds go through a settlement
// window. So this function's job is: validate, atomically reserve the
// money on our side, ask the bank to queue the refund, and return - it
// does NOT wait for the bank to confirm the money actually moved. The
// real outcome always arrives later via the signed webhook handled in
// refund.webhook.controller.js, which calls confirmRefundOutcome() below.
async function requestRefund({
  merchantId,
  transactionId,
  reference: paymentReference, // caller's own transaction/payment reference - alternative to transactionId (SwiftPay's internal id), since a merchant integrating over the API generally only ever has the reference it got back from initialize()/verify(), never our internal _id.
  amount,
  reason,
  destinationBankCode,
  destinationAccountNumber,
  destinationAccountName,
  idempotencyKey = null,
}) {
  if (!transactionId && !paymentReference) {
    throw new Error('transaction_reference_required');
  }

  // Idempotency check FIRST, before touching the transaction at all -
  // same ordering as payout.service.js's requestPayout(). A retried
  // identical request (browser retry, network timeout, worker restart)
  // returns the already-created refund instead of re-validating and
  // re-claiming refund headroom a second time.
  if (idempotencyKey) {
    const existing = await Refund.findOne({ merchant: merchantId, idempotencyKey });
    if (existing) {
      return existing;
    }
  }

  const transaction = transactionId
    ? await Transaction.findById(transactionId)
    : await Transaction.findOne({ reference: paymentReference });

  if (!transaction) throw new Error('transaction_not_found');
  if (transaction.merchant.toString() !== merchantId.toString()) {
    throw new Error('transaction_not_found');
  }
  if (!['success', 'partial', 'over'].includes(transaction.status)) {
    throw new Error('transaction_not_refundable');
  }
  if (!destinationBankCode || !destinationAccountNumber || !destinationAccountName) {
    throw new Error('destination_account_required');
  }

  const mode = transaction.mode || 'live';

  // Best-effort figure just for the early validation error message - the
  // real, race-proof check is the atomic findOneAndUpdate guard below.
  const bestEffortRefundable = transaction.amountReceived - transaction.refundedAmount;
  const refundAmount = amount == null ? bestEffortRefundable : amount;
  if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
    throw new Error('invalid_refund_amount');
  }

  const reference = `rf_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let refund;
  try {
    session.startTransaction();

    // Atomically claim `refundAmount` of refundable headroom on the
    // transaction itself, in the same step as checking it's available -
    // a compare-and-increment on a single document, same pattern as
    // wallet.service.js's reserveFunds. This is what actually prevents
    // two concurrent refund requests from together over-refunding the
    // transaction, regardless of what either request read before
    // starting its session.
    const claimed = await Transaction.findOneAndUpdate(
      {
        _id: transaction._id,
        $expr: {
          $gte: [
            { $subtract: ['$amountReceived', '$refundedAmount'] },
            refundAmount,
          ],
        },
      },
      { $inc: { refundedAmount: refundAmount } },
      { new: true, session }
    );

    if (!claimed) {
      throw new Error('refund_exceeds_refundable_amount');
    }

    await debitWallet(merchantId, refundAmount, session, transaction.currency, mode);

    const [created] = await Refund.create(
      [
        {
          merchant: merchantId,
          transaction: transaction._id,
          reference,
          idempotencyKey,
          amount: refundAmount,
          currency: transaction.currency,
          mode,
          reason: reason || null,
          destinationBankCode,
          destinationAccountNumber,
          destinationAccountName,
          status: 'pending',
        },
      ],
      { session, ordered: true }
    );
    refund = created;

    await postDoubleEntry({
      entryGroup: `refund_${refund._id}`,
      amount: refundAmount,
      currency: transaction.currency,
      sourceType: 'refund',
      sourceRef: refund._id.toString(),
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Refund issued - funds held pending bank confirmation' },
      credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Funds moved to clearing pending bank confirmation' },
      session,
    });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    // Same race payout.service.js guards against: two concurrent
    // requests both passed the pre-check above (neither had committed
    // yet), so the DB's unique index is what actually decides - the
    // loser gets a duplicate-key error here, not a second refund.
    if (err.code === 11000 && idempotencyKey) {
      const raced = await Refund.findOne({ merchant: merchantId, idempotencyKey });
      if (raced) return raced;
    }
    throw err;
  }

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'refund.requested',
    entityType: 'Refund',
    entityRef: refund._id.toString(),
    metadata: { transactionId: transaction._id.toString(), amount: refundAmount, mode },
  });

  // Submit to the bank - this call only confirms the bank RECEIVED the
  // instruction, not that the refund completed. Awaited (not
  // fire-and-forget) because we do want to know right away if the bank
  // rejected the submission outright (e.g. malformed destination
  // account) - but this is just an acknowledgement round trip, not a
  // wait for settlement, so it stays fast.
    let bankAccepted = false;

  try {
    const submitCall =
      mode === 'live'
        ? sendRefundInstruction
        : simulateRefundInstruction;

    const result = await submitCall({
      idempotencyKey: refund.reference,
      amountMajorUnits: toMajorUnits(refundAmount),
      originalBankReference: transaction.bankReference,
      destinationAccountNumber,
      destinationBank: destinationBankCode,
      destinationAccountName,
    });

    if (result.accepted) {
      // From this point onward, the bank may already have the refund
      // queued. Any local failure must therefore NEVER trigger an
      // automatic reversal.
      bankAccepted = true;

      refund.status = 'submitted';
      refund.submissionRef = result.submissionRef || null;
      refund.submittedAt = new Date();

      await refund.save();

      await auditLog.record({
        actorType: 'system',
        actorRef: 'refund_service',
        action: 'refund.submitted',
        entityType: 'Refund',
        entityRef: refund._id.toString(),
        metadata: {
          submissionRef: refund.submissionRef,
          mode,
        },
      });
    } else {
      // The bank explicitly rejected the submission itself.
      // Nothing was queued, so reversing our local reservation is safe.
      refund =
        (await reverseRefund(
          refund._id,
          result.rejectionReason || 'bank_rejected_submission'
        )) || refund;
    }
  } catch (err) {
    if (bankAccepted || err.ambiguousOutcome) {
      // Either the bank definitely accepted the refund and our local
      // bookkeeping failed, or we cannot determine whether the bank
      // received the instruction.
      //
      // NEVER reverse automatically in either case.
      refund.failureReason = bankAccepted
        ? `local_finalization_failed_after_bank_acceptance: ${err.message}`
        : `submission_ambiguous: ${err.message}`;

      // Keep it in a state that requires reconciliation.
      // If the save itself is what failed, this save may fail too;
      // the important rule is that we NEVER call reverseRefund here.
      refund.status = 'ambiguous';

      try {
        await refund.save();
      } catch (saveErr) {
        await auditLog.record({
          actorType: 'system',
          actorRef: 'refund_service',
          action: 'refund.local_save_failed_after_bank_acceptance',
          entityType: 'Refund',
          entityRef: refund._id.toString(),
          severity: 'critical',
          metadata: {
            originalError: err.message,
            saveError: saveErr.message,
          },
        }).catch(() => {});
      }

      await auditLog.record({
        actorType: 'system',
        actorRef: 'refund_service',
        action: 'refund.ambiguous_outcome',
        entityType: 'Refund',
        entityRef: refund._id.toString(),
        severity: 'critical',
        metadata: {
          error: err.message,
          bankAccepted,
        },
      }).catch(() => {});
    } else {
      // Only a definite submission rejection reaches this path.
      // The bank did not queue the refund, so returning the reserved
      // money to the merchant is safe.
      refund =
        (await reverseRefund(refund._id, err.message)) || refund;
    }
  }



  return refund;
}

// Called ONLY from refund.webhook.controller.js, after the bank
// partner's signature has been verified. This is the sole path by which
// a refund is ever marked 'successful' - no other code path is trusted
// to do that, mirroring how webhook.processor.js is the sole path for
// marking an inbound payment 'success'.
async function confirmRefundOutcome({ reference, success, providerRef, failureReason }) {
  if (success) {
    // Atomic, idempotent transition: only applies if the refund is still
    // waiting on this confirmation. A duplicate or replayed webhook for
    // an already-resolved refund matches nothing here and is a no-op,
    // rather than re-crediting or double-processing anything.
    const refund = await Refund.findOneAndUpdate(
      { reference, status: { $in: ['pending', 'submitted'] } },
      { $set: { status: 'successful', providerRef: providerRef || null, confirmedAt: new Date() } },
      { new: true }
    );

    if (!refund) {
      await auditLog.record({
        actorType: 'system',
        actorRef: 'refund_webhook',
        action: 'refund.webhook_ignored_duplicate_or_unknown',
        severity: 'info',
        metadata: { reference, outcome: 'success' },
      });
      return null;
    }

    await auditLog.record({
      actorType: 'system',
      actorRef: 'refund_webhook',
      action: 'refund.confirmed_successful',
      entityType: 'Refund',
      entityRef: refund._id.toString(),
      metadata: { providerRef },
    });

    // Generic notification, same shape/mechanism as transaction.success -
    // SwiftPay doesn't know or care who's listening on the other end
    // (Campaign Platform, a future shop, a future school); it just
    // reports that a refund it was asked to process has resolved.
    const merchant = await Merchant.findById(refund.merchant);
    if (merchant) {
      dispatchMerchantWebhook(merchant, {
        type: 'refund.succeeded',
        data: refund.toObject(),
      }).catch(() => {});
    }

    return refund;
  }

  // Bank confirmed the refund failed after having accepted the
  // submission. Look it up by reference and hand off to reverseRefund,
  // which owns its own atomic idempotency lock.
  const refund = await Refund.findOne({ reference });
  if (!refund) {
    await auditLog.record({
      actorType: 'system',
      actorRef: 'refund_webhook',
      action: 'refund.webhook_ignored_duplicate_or_unknown',
      severity: 'info',
      metadata: { reference, outcome: 'failure' },
    });
    return null;
  }

  return reverseRefund(refund._id, failureReason || 'bank_declined_after_submission', providerRef);
}

// Idempotent by construction: the pending/submitted -> reversing
// transition is a single atomic findOneAndUpdate, so no matter how many
// times this is called concurrently or after a retry (a flaky bank
// rejection response, a retried webhook, a crash mid-reversal), only one
// caller ever wins the lock and actually performs the wallet
// credit/ledger/headroom-release. Every other caller gets `null` back
// and does nothing further.
async function reverseRefund(refundId, reason, providerRef = null) {
  const lock = await Refund.findOneAndUpdate(
    { _id: refundId, status: { $in: ['pending', 'submitted'] } },
    { $set: { status: 'reversing' } },
    { new: true }
  );

  if (!lock) {
    // Already reversed, already successful, or already mid-reversal by
    // another caller - nothing to do.
    return null;
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // Give back the refundable headroom claimed in requestRefund, so a
    // reversed refund doesn't permanently eat into how much of this
    // transaction can still be refunded.
    await Transaction.updateOne(
      { _id: lock.transaction },
      { $inc: { refundedAmount: -lock.amount } },
      { session }
    );

    await creditWallet(lock.merchant, lock.amount, session, lock.currency, lock.mode || 'live');
    await postDoubleEntry({
      entryGroup: `refund_reversal_${lock._id}`,
      amount: lock.amount,
      currency: lock.currency,
      sourceType: 'reversal',
      sourceRef: lock._id.toString(),
      debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Refund reversal' },
      credit: { accountType: 'merchant_wallet', accountRef: lock.merchant.toString(), description: 'Refund reversal - funds returned' },
      session,
    });

    lock.status = 'reversed';
    lock.failureReason = reason;
    if (providerRef) lock.providerRef = providerRef;
    lock.confirmedAt = new Date();
    await lock.save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }

  await auditLog.record({
    actorType: 'system',
    actorRef: 'refund_service',
    action: 'refund.reversed',
    entityType: 'Refund',
    entityRef: lock._id.toString(),
    severity: 'warning',
    metadata: { reason, mode: lock.mode },
  });

  const merchant = await Merchant.findById(lock.merchant);
  if (merchant) {
    dispatchMerchantWebhook(merchant, {
      type: 'refund.failed',
      data: lock.toObject(),
    }).catch(() => {});
  }

  return lock;
}

async function listForMerchant(merchantId) {
  return Refund.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, refundId) {
  const refund = await Refund.findOne({ _id: refundId, merchant: merchantId });
  if (!refund) throw new Error('refund_not_found');
  return refund;
}

module.exports = {
  requestRefund,
  confirmRefundOutcome,
  listForMerchant,
  getForMerchant,
};
