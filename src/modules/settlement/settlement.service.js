// src/modules/settlement/settlement.service.js

const crypto = require('crypto');
const mongoose = require('mongoose');

const Transaction = require('../transaction/transaction.model');
const SettlementBatch = require('./settlement.model');

const {
  moveToAvailable,
  getOrCreateWallet,
} = require('../wallet/wallet.service');

const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

const STALE_SETTLEMENT_LOCK_MINUTES = 15;

function newBatchReference() {
  return `stlbatch_${crypto.randomBytes(10).toString('hex')}`;
}

/**
 * Claim one transaction for settlement processing.
 *
 * The claim is atomic. If another worker already claimed the
 * transaction, this returns null.
 */
async function claimTransaction({
  transactionId,
  batchId,
  phase,
  session = null,
}) {
  const staleBefore = new Date(
    Date.now() -
      STALE_SETTLEMENT_LOCK_MINUTES * 60 * 1000
  );

  return Transaction.findOneAndUpdate(
    {
      _id: transactionId,

      $or: [
        {
          settlementLockId: null,
        },
        {
          settlementLockAt: { $lt: staleBefore },
        },
      ],
    },
    {
      $set: {
        settlementLockId: batchId,
        settlementLockPhase: phase,
        settlementLockAt: new Date(),
      },
    },
    {
      new: true,
      session,
    }
  );
}

/**
 * Release a settlement lock.
 *
 * The batch ID is included in the filter so one worker cannot
 * accidentally release another worker's lock.
 */
async function releaseSettlementLock({
  transactionId,
  batchId,
  session = null,
}) {
  await Transaction.updateOne(
    {
      _id: transactionId,
      settlementLockId: batchId,
    },
    {
      $set: {
        settlementLockId: null,
        settlementLockPhase: null,
        settlementLockAt: null,
      },
    },
    { session }
  );
}

async function runSettlePhase({
  currency = 'NGN',
  now = new Date(),
} = {}) {
  const cutoffTime = new Date(
    now.getTime() -
      limits.SETTLEMENT_CUTOFF_MINUTES * 60 * 1000
  );

  const batch = await SettlementBatch.create({
    batchReference: newBatchReference(),
    phase: 'settle',
    currency,
    cutoffTime,
    status: 'processing',
  });

  const eligible = await Transaction.find({
    currency,
    settlementStatus: 'pending_settlement',
    createdAt: { $lte: cutoffTime },
  })
    .limit(limits.SETTLEMENT_BATCH_SIZE)
    .lean();

  let totalAmount = 0;
  let successfulCount = 0;
  const failedIds = [];

  for (const txn of eligible) {
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // Now wrapped in a single Mongo transaction, same pattern as
      // runMakeAvailablePhase below - previously this phase did the
      // claim and the status flip as two separate, un-transacted
      // operations. The status-based guards made that safe against
      // double-settlement even so, but leaving it un-transacted meant
      // a crash between the two steps could leave a transaction
      // claimed-but-not-settled for longer than necessary, and the
      // two phases followed different patterns for no real reason.
      const claimed = await claimTransaction({
        transactionId: txn._id,
        batchId: batch._id,
        phase: 'settle',
        session,
      });

      if (!claimed) {
        await session.abortTransaction();
        session.endSession();
        continue;
      }

      const updated = await Transaction.findOneAndUpdate(
        {
          _id: txn._id,
          settlementStatus: 'pending_settlement',
          settlementLockId: batch._id,
        },
        {
          $set: {
            settlementStatus: 'settled',
            settledAt: now,
            settlementBatch: batch._id,
            settlementLockId: null,
            settlementLockPhase: null,
            settlementLockAt: null,
          },
        },
        { new: true, session }
      );

      if (!updated) {
        throw new Error('settlement_transaction_claim_lost');
      }

      await session.commitTransaction();
      session.endSession();

      totalAmount += updated.netAmount;
      successfulCount++;
    } catch (err) {
      await session.abortTransaction().catch(() => {});
      session.endSession();

      failedIds.push(txn._id);

      // No releaseSettlementLock call needed here - the transaction abort
      // above already reverted the claim, same as runMakeAvailablePhase.
      await auditLog.record({
        actorType: 'system',
        actorRef: 'settlement_service',
        action: 'settlement.settle_failed',
        entityType: 'Transaction',
        entityRef: txn._id.toString(),
        severity: 'critical',
        metadata: { error: err.message },
      });
    }
  }

  batch.status =
    failedIds.length &&
    failedIds.length === eligible.length
      ? 'failed'
      : 'completed';

  batch.transactionCount = successfulCount;
  batch.totalAmount = totalAmount;
  batch.failedTransactionIds = failedIds;
  batch.completedAt = new Date();

  await batch.save();

  await auditLog.record({
    actorType: 'system',
    actorRef: 'settlement_service',
    action: 'settlement.batch_settled',
    entityType: 'SettlementBatch',
    entityRef: batch._id.toString(),
    metadata: {
      currency,
      transactionCount: successfulCount,
      totalAmount,
      failedCount: failedIds.length,
    },
  });

  return batch;
}

async function runMakeAvailablePhase({
  currency = 'NGN',
  now = new Date(),
} = {}) {
  const cutoffTime = new Date(
    now.getTime() -
      limits.SETTLEMENT_AVAILABILITY_DELAY_MINUTES * 60 * 1000
  );

  const batch = await SettlementBatch.create({
    batchReference: newBatchReference(),
    phase: 'make_available',
    currency,
    cutoffTime,
    status: 'processing',
  });

  const eligible = await Transaction.find({
    currency,
    settlementStatus: 'settled',
    settledAt: { $lte: cutoffTime },
  })
    .limit(limits.SETTLEMENT_BATCH_SIZE)
    .lean();

  let totalAmount = 0;
  let successfulCount = 0;
  const failedIds = [];

  for (const txn of eligible) {
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      /*
       * Claim the transaction inside the same MongoDB transaction
       * that moves the wallet balance.
       *
       * This is the important concurrency protection.
       */
      const claimed = await claimTransaction({
        transactionId: txn._id,
        batchId: batch._id,
        phase: 'make_available',
        session,
      });

      if (!claimed) {
        await session.abortTransaction();
        session.endSession();
        continue;
      }

      const wallet = await getOrCreateWallet(
        txn.merchant,
        txn.currency,
        txn.mode || 'live',
        session
      );

      await moveToAvailable(
        wallet._id,
        txn.netAmount,
        session
      );

      const updated = await Transaction.updateOne(
        {
          _id: txn._id,
          settlementStatus: 'settled',
          settlementLockId: batch._id,
        },
        {
          $set: {
            settlementStatus: 'available',
            availableAt: now,
            settlementBatch: batch._id,
            settlementLockId: null,
            settlementLockPhase: null,
            settlementLockAt: null,
          },
        },
        { session }
      );

      if (updated.matchedCount !== 1) {
        throw new Error(
          'settlement_transaction_claim_lost'
        );
      }

      await session.commitTransaction();
      session.endSession();

      totalAmount += txn.netAmount;
      successfulCount++;
    } catch (err) {
      await session.abortTransaction().catch(() => {});
      session.endSession();

      failedIds.push(txn._id);

      await auditLog.record({
        actorType: 'system',
        actorRef: 'settlement_service',
        action: 'settlement.make_available_failed',
        entityType: 'Transaction',
        entityRef: txn._id.toString(),
        severity: 'critical',
        metadata: {
          error: err.message,
          merchant: txn.merchant.toString(),
          amount: txn.netAmount,
        },
      });
    }
  }

  batch.status =
    failedIds.length &&
    failedIds.length === eligible.length
      ? 'failed'
      : 'completed';

  batch.transactionCount = successfulCount;
  batch.totalAmount = totalAmount;
  batch.failedTransactionIds = failedIds;
  batch.completedAt = new Date();

  await batch.save();

  await auditLog.record({
    actorType: 'system',
    actorRef: 'settlement_service',
    action: 'settlement.batch_made_available',
    entityType: 'SettlementBatch',
    entityRef: batch._id.toString(),
    metadata: {
      currency,
      transactionCount: successfulCount,
      totalAmount,
      failedCount: failedIds.length,
    },
  });

  return batch;
}

async function runSettlementCycle({
  currency = 'NGN',
} = {}) {
  const now = new Date();

  const settleBatch = await runSettlePhase({
    currency,
    now,
  });

  const availableBatch =
    await runMakeAvailablePhase({
      currency,
      now,
    });

  return {
    settleBatch,
    availableBatch,
  };
}

async function listBatches({
  currency,
  phase,
  limit = 50,
} = {}) {
  const query = {};

  if (currency) {
    query.currency = currency;
  }

  if (phase) {
    query.phase = phase;
  }

  return SettlementBatch.find(query)
    .sort({ createdAt: -1 })
    .limit(limit);
}

module.exports = {
  runSettlePhase,
  runMakeAvailablePhase,
  runSettlementCycle,
  listBatches,
};
