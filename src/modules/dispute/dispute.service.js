// src/modules/dispute/dispute.service.js
const mongoose = require('mongoose');
const Dispute = require('./dispute.model');
const Transaction = require('../transaction/transaction.model');
const { debitWallet, creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

async function openDispute({ merchantId, transactionId, amount, reason, reasonDetail }) {
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) throw new Error('transaction_not_found');
  if (transaction.merchant.toString() !== merchantId.toString()) {
    throw new Error('transaction_not_found');
  }
  if (!['success', 'partial', 'over'].includes(transaction.status)) {
    throw new Error('transaction_not_disputable');
  }

  const disputeAmount = amount == null ? transaction.amountReceived : amount;
  if (!Number.isInteger(disputeAmount) || disputeAmount <= 0) {
    throw new Error('invalid_dispute_amount');
  }

  const mode = transaction.mode || 'live';
  const evidenceDueBy = new Date(Date.now() + limits.DISPUTE_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const session = await mongoose.startSession();
  let dispute;
  try {
    session.startTransaction();

    await debitWallet(merchantId, disputeAmount, session, transaction.currency, mode);

    // openLock defaults to true (see dispute.model.js) - the partial
    // unique index on { transaction, openLock } is what actually
    // enforces "at most one open dispute per transaction". If a second
    // dispute is already open on this transaction, this insert fails
    // with a duplicate-key error (code 11000), caught below, instead of
    // silently creating a second freeze on the same money.
    const [created] = await Dispute.create(
      [
        {
          merchant: merchantId,
          transaction: transactionId,
          amount: disputeAmount,
          currency: transaction.currency,
          mode,
          reason: reason || 'other',
          reasonDetail: reasonDetail || null,
          status: 'open',
          evidenceDueBy,
        },
      ],
      { session, ordered: true }
    );
    dispute = created;

    await postDoubleEntry({
      entryGroup: `dispute_${dispute._id}`,
      amount: disputeAmount,
      currency: transaction.currency,
      sourceType: 'adjustment',
      sourceRef: dispute._id.toString(),
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Funds frozen pending dispute' },
      credit: { accountType: 'suspense', accountRef: `dispute_${dispute._id}`, description: 'Disputed funds held in suspense' },
      session,
    });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    if (err.code === 11000) {
      throw new Error('dispute_already_open_for_transaction');
    }
    throw err;
  }

  await auditLog.record({
    actorType: 'system',
    actorRef: 'dispute_intake',
    action: 'dispute.opened',
    entityType: 'Dispute',
    entityRef: dispute._id.toString(),
    severity: 'critical',
    metadata: { transactionId, amount: disputeAmount, reason, mode },
  });

  return dispute;
}

async function submitEvidence({ merchantId, disputeId, description, url }) {
  const dispute = await Dispute.findOne({ _id: disputeId, merchant: merchantId });
  if (!dispute) throw new Error('dispute_not_found');
  if (!['open', 'under_review'].includes(dispute.status)) {
    throw new Error('dispute_already_resolved');
  }
  if (!description) throw new Error('evidence_description_required');

  dispute.evidence.push({ description, url: url || null, submittedAt: new Date() });
  dispute.status = 'under_review';
  await dispute.save();

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'dispute.evidence_submitted',
    entityType: 'Dispute',
    entityRef: dispute._id.toString(),
  });

  return dispute;
}

async function resolveDispute({ disputeId, outcome, resolution }) {
  if (!['won', 'lost'].includes(outcome)) throw new Error('invalid_outcome');

  const dispute = await Dispute.findOneAndUpdate(
    { _id: disputeId, status: { $in: ['open', 'under_review'] } },
    { $set: { status: 'resolving' } },
    { new: true }
  );

  if (!dispute) {
    const exists = await Dispute.exists({ _id: disputeId });
    if (!exists) throw new Error('dispute_not_found');
    throw new Error('dispute_already_resolved');
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    if (outcome === 'won') {
      await creditWallet(dispute.merchant, dispute.amount, session, dispute.currency, dispute.mode || 'live');
      await postDoubleEntry({
        entryGroup: `dispute_resolution_${dispute._id}`,
        amount: dispute.amount,
        currency: dispute.currency,
        sourceType: 'reversal',
        sourceRef: dispute._id.toString(),
        debit: { accountType: 'suspense', accountRef: `dispute_${dispute._id}`, description: 'Dispute won - releasing frozen funds' },
        credit: { accountType: 'merchant_wallet', accountRef: dispute.merchant.toString(), description: 'Dispute won - funds returned to wallet' },
        session,
      });
    } else {
      await postDoubleEntry({
        entryGroup: `dispute_resolution_${dispute._id}`,
        amount: dispute.amount,
        currency: dispute.currency,
        sourceType: 'adjustment',
        sourceRef: dispute._id.toString(),
        debit: { accountType: 'suspense', accountRef: `dispute_${dispute._id}`, description: 'Dispute lost - releasing suspense' },
        credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Dispute lost - funds leaving platform to customer/card network' },
        session,
      });
    }

    dispute.status = outcome;
    dispute.resolution = resolution || null;
    dispute.resolvedAt = new Date();
    // Release the partial-unique-index lock now that this dispute is
    // resolved, so the transaction is free to be disputed again in the
    // future (e.g. a different, later dispute) without being blocked by
    // this now-closed one.
    dispute.openLock = undefined;
    await dispute.save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await Dispute.updateOne(
      { _id: dispute._id, status: 'resolving' },
      { $set: { status: 'under_review', resolution: `resolution_failed: ${err.message}` } }
    ).catch(() => {});
    await session.abortTransaction();
    session.endSession();
    throw err;
  }

  await auditLog.record({
    actorType: 'system',
    actorRef: 'dispute_resolution',
    action: `dispute.${outcome}`,
    entityType: 'Dispute',
    entityRef: dispute._id.toString(),
    severity: 'critical',
    metadata: { resolution },
  });

  return dispute;
}

async function listForMerchant(merchantId) {
  return Dispute.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, disputeId) {
  const dispute = await Dispute.findOne({ _id: disputeId, merchant: merchantId });
  if (!dispute) throw new Error('dispute_not_found');
  return dispute;
}

module.exports = { openDispute, submitEvidence, resolveDispute, listForMerchant, getForMerchant };
