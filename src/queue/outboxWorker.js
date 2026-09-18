// src/queue/outboxWorker.js
//
// Separate long-running process (like webhookWorker.js and
// merchantWebhookWorker.js) that dispatches OutboxEvent documents -
// see src/modules/outbox/outboxEvent.model.js for why these exist and
// the guarantee they provide.
//
// Deliberately a plain poll loop against Mongo, not a BullMQ queue: the
// durability guarantee here comes from the outbox documents themselves
// being created atomically with the financial transaction, not from a
// message broker. Adding Redis/BullMQ into that specific guarantee would
// mean "the financial commit is atomic with a Mongo write, which is then
// separately, non-atomically, expected to reach Redis" - reintroducing
// exactly the kind of gap this pattern exists to close. A worker that
// crashes mid-poll just leaves its claimed events in `processing`,
// recovered by redriveStuckProcessing() below.

const mongoose = require('mongoose');
const { mongoUri } = require('../config/env');
const logger = require('../utils/logger');
const auditLog = require('../modules/audit/auditLog.service');

const { claimBatch, markCompleted, markFailed, redriveStuckProcessing } = require('../modules/outbox/outbox.service');
const { recordHeartbeat } = require('../modules/admin/cronHeartbeat.model');

const Transaction = require('../modules/transaction/transaction.model');
const Merchant = require('../modules/merchant/merchant.model');
const { deactivateVirtualAccount } = require('../modules/virtualAccount/virtualAccount.service');
const { dispatchMerchantWebhook } = require('../utils/merchantWebhook');
const { markInvoicePaidByTransaction } = require('../modules/subscription/subscription.service');

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 2000;
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE) || 20;
const STALE_PROCESSING_MS = Number(process.env.OUTBOX_STALE_PROCESSING_MS) || 5 * 60 * 1000;
const REDRIVE_INTERVAL_MS = 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleEvent(event) {
  switch (event.eventType) {
    case 'deactivate_virtual_account': {
      const { merchantId, accountNumber } = event.payload;
      await deactivateVirtualAccount({ merchantId, accountNumber });
      return;
    }

    case 'dispatch_merchant_webhook': {
      const { transactionId, merchantReference } = event.payload;
      const transaction = await Transaction.findById(transactionId);
      if (!transaction) {
        // Nothing to notify about anymore - not an error, just a no-op
        // (shouldn't normally happen since transactions aren't deleted,
        // but don't retry forever chasing a document that's gone).
        return;
      }
      const merchant = await Merchant.findById(transaction.merchant);
      if (!merchant) return;

      await dispatchMerchantWebhook(merchant, {
        type: 'transaction.success',
        data: { ...transaction.toObject(), tx_ref: merchantReference },
      });
      return;
    }

    case 'mark_invoice_paid': {
      const { transactionId } = event.payload;
      const transaction = await Transaction.findById(transactionId);
      if (!transaction) return;
      await markInvoicePaidByTransaction(transaction);
      return;
    }

    default:
      throw new Error(`unknown_outbox_event_type:${event.eventType}`);
  }
}

async function tick() {
  const events = await claimBatch(BATCH_SIZE);

  for (const event of events) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await handleEvent(event);
      // eslint-disable-next-line no-await-in-loop
      await markCompleted(event._id);
    } catch (err) {
      logger.error(
        { err, eventId: event._id.toString(), eventType: event.eventType, attempts: event.attempts },
        '[outboxWorker] event failed'
      );

      // eslint-disable-next-line no-await-in-loop
      const { permanentlyFailed } = await markFailed(event, err);

      if (permanentlyFailed) {
        // eslint-disable-next-line no-await-in-loop
        await auditLog.record({
          actorType: 'system',
          actorRef: 'outbox_worker',
          action: 'outbox.event_permanently_failed',
          entityType: 'OutboxEvent',
          entityRef: event._id.toString(),
          severity: 'critical',
          metadata: {
            eventType: event.eventType,
            sourceType: event.sourceType,
            sourceRef: event.sourceRef,
            attempts: event.attempts,
            error: err.message,
          },
        }).catch(() => {});
      }
    }
  }

  return events.length;
}

async function main() {
  await mongoose.connect(mongoUri);
  logger.info('[outboxWorker] started');

  const redriveTimer = setInterval(() => {
    redriveStuckProcessing(STALE_PROCESSING_MS)
      .then((count) => {
        if (count > 0) logger.warn({ count }, '[outboxWorker] recovered stuck-processing events');
        return recordHeartbeat('outbox-worker', true);
      })
      .catch((err) => {
        logger.error({ err }, '[outboxWorker] redrive failed');
        return recordHeartbeat('outbox-worker', false, err.message).catch(() => {});
      });
  }, REDRIVE_INTERVAL_MS);
  redriveTimer.unref();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const processed = await tick();
      if (processed === 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      logger.error({ err }, '[outboxWorker] tick failed');
      // eslint-disable-next-line no-await-in-loop
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

module.exports = { tick, handleEvent };

if (require.main === module) {
  main().catch((err) => {
    console.error('[outboxWorker] fatal:', err);
    process.exit(1);
  });
}
