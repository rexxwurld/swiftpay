// src/modules/webhook/webhook.processor.js

const WebhookEvent = require("./webhookEvent.model");

const {
  findByAccountNumber,
} = require("../virtualAccount/virtualAccount.service");

const {
  recordIncomingPayment,
} = require("../transaction/transaction.service");

const auditLog = require("../audit/auditLog.service");
const logger = require("../../utils/logger");

const {
  enqueueWebhookEvent,
} = require("../../queue/webhookQueue");
const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 minutes

/*
 * Persists the webhook event before processing it.
 *
 * providerEventId is used to prevent the same provider event from being
 * persisted more than once.
 */
async function enqueue({
  rawBody,
  signature,
  providerEventId,
}) {
  if (!providerEventId) {
    throw new Error("missing_provider_event_id");
  }

  let event;

  try {
    event = await WebhookEvent.create({
      source: "bank_partner",
      providerEventId,
      rawBody,
      signature,
      status: "queued",
    });
  } catch (err) {
    /*
     * MongoDB duplicate-key error means this exact provider event has
     * already been received.
     *
     * This is expected when a bank retries a webhook.
     */
    if (err.code === 11000) {
      event = await WebhookEvent.findOne({
        source: "bank_partner",
        providerEventId,
      });

      if (event) {
        return event;
      }
    }

    throw err;
  }

  try {
    await enqueueWebhookEvent(event._id);
  } catch (err) {
    logger.error(
      {
        err,
        eventId: event._id.toString(),
      },
      "[webhook.processor] failed to enqueue event onto durable queue"
    );
  }

  return event;
}



async function processEvent(eventId) {
  /*
   * Atomically claim the event.
   *
   * This prevents two workers from processing the same webhook
   * simultaneously.
   *
   * Also reclaims events stuck at "processing" for too long - e.g. a
   * worker crashed after claiming but before saving a final status.
   * Without this, such an event would be re-enqueued by
   * redriveStuckEvents() forever but never actually match this claim,
   * staying stuck permanently.
   */
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const event = await WebhookEvent.findOneAndUpdate(
    {
      _id: eventId,
      $or: [
        { status: "queued" },
        { status: "processing", processingStartedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: "processing",
        processingStartedAt: new Date(),
      },
      $inc: {
        attempts: 1,
      },
    },
    {
      new: true,
    }
  );

  /*
   * Another worker may already be processing the event.
   *
   * In that case we simply stop here.
   */
  if (!event) {
    return;
  }

  try {
    const {
      accountNumber,
      amountReceived,
      currency,
      bankReference,
    } = event.rawBody;

    if (
      !accountNumber ||
      !Number.isInteger(amountReceived) ||
      amountReceived <= 0
    ) {
      throw new Error("invalid_payload");
    }

    // Inbound collection is NGN-only by design (see config/currencies.js -
    // dedicated virtual accounts are Nigerian bank accounts; VirtualAccount
    // has no currency field at all because there is only one). A webhook
    // claiming any other currency for an inbound transfer is either a
    // provider bug or a forged/tampered payload - either way, recording it
    // as-is would silently mislabel the money. Fail closed rather than
    // defaulting past it.
    if (currency && String(currency).toUpperCase() !== "NGN") {
      await auditLog.record({
        actorType: "system",
        actorRef: "webhook_processor",
        action: "webhook.unexpected_currency",
        severity: "critical",
        metadata: { accountNumber, bankReference, currency },
      });

      event.status = "failed";
      event.lastError = `unexpected_currency:${currency}`;
      await event.save();
      return;
    }

    const account = await findByAccountNumber(accountNumber);

    /*
     * The SwiftPay-side virtual account must still be assigned.
     *
     * The BANK is responsible for deactivating its actual bank account.
     * SwiftPay only updates its local virtual-account state.
     */
    if (!account || account.status !== "assigned") {
      await auditLog.record({
        actorType: "system",
        actorRef: "webhook_processor",
        action: "webhook.unrecognized_account",
        severity: "critical",
        metadata: {
          accountNumber,
          bankReference,
          accountStatus: account?.status || "not_found",
        },
      });

      event.status = "failed";
      event.lastError = "unrecognized_or_inactive_account";

      await event.save();

      return;
    }

    const merchantId = account.merchant;
    const customerId = account.customer;
    const virtualAccountId = account._id;
    const amountExpected = account.amountExpected ?? null;
    const merchantReference = account.reference;

    const {
      transaction,
      duplicate,
    } = await recordIncomingPayment({
      reference: merchantReference,
      merchantId,
      customerId,
      virtualAccountId,
      amountReceived,
      amountExpected,
      currency: currency || "NGN",
      bankReference,
    });

    /*
     * Post-payment side effects (account deactivation, merchant webhook,
     * invoice reconciliation) are no longer run from here at all.
     * recordIncomingPayment() enqueues them as OutboxEvent documents
     * INSIDE the same DB transaction as the financial commit (see
     * outboxEvent.model.js) - so if the transaction committed, the
     * outbox events already exist, atomically, regardless of whether
     * this function crashes right after. src/queue/outboxWorker.js is
     * the independent process that actually dispatches them.
     *
     * This also means a replay of the same webhook event (duplicate:
     * true) doesn't need to re-derive or re-check "did the side effects
     * already run" here anymore - that question doesn't need answering
     * in this function at all, which is the whole point of the pattern.
     */

    event.status = "processed";
    event.processedAt = new Date();

    await event.save();
  } catch (err) {
    event.lastError = err.message;

    event.status =
      event.attempts >= MAX_ATTEMPTS
        ? "failed"
        : "queued";

    await event.save();

    if (event.status === "failed") {
      await auditLog.record({
        actorType: "system",
        actorRef: "webhook_processor",
        action: "webhook.processing_failed_permanently",
        severity: "critical",
        metadata: {
          eventId: event._id.toString(),
          providerEventId: event.providerEventId,
          error: err.message,
        },
      });
    }

    throw err;
  }
}

async function redriveStuckEvents() {
  const stuck = await WebhookEvent.find({
    status: {
      $in: ["queued", "processing"],
    },
  });

  for (const event of stuck) {
    await enqueueWebhookEvent(event._id).catch((err) => {
      logger.error(
        {
          err,
          eventId: event._id.toString(),
          providerEventId: event.providerEventId,
        },
        "[webhook.processor] failed to redrive stuck event onto durable queue"
      );
    });
  }

  return stuck.length;
}

// Manual redrive for a PERMANENTLY failed event (dead-lettered after
// exhausting MAX_ATTEMPTS in processEvent(), as opposed to
// redriveStuckEvents() above which recovers events that crashed mid-flight).
// This is req. #5's "provide manual redrive" - previously there was no way
// for an operator to retry a dead-lettered webhook event at all short of
// editing the database by hand.
//
// BullMQ job IDs are pinned to the WebhookEvent's Mongo _id (see
// webhookQueue.js), so a failed job with that ID already exists in Redis
// in a terminal state - `queue.add()` with the same ID would be a no-op
// against that existing job. Remove it first so the fresh attempt actually
// runs, don't just fire another add() into a job that will never pick it up.
async function redriveFailedEvent(eventId) {
  const event = await WebhookEvent.findById(eventId);
  if (!event) {
    throw new Error("webhook_event_not_found");
  }
  if (event.status !== "failed") {
    throw new Error("webhook_event_not_in_failed_state");
  }

  const { webhookQueue } = require("../../queue/webhookQueue");
  const existingJob = await webhookQueue.getJob(event._id.toString()).catch(() => null);
  if (existingJob) {
    await existingJob.remove().catch(() => {});
  }

  event.status = "queued";
  event.attempts = 0;
  event.lastError = null;
  event.processingStartedAt = null;
  await event.save();

  await enqueueWebhookEvent(event._id);
  return event;
}

module.exports = {
  enqueue,
  processEvent,
  redriveStuckEvents,
  redriveFailedEvent,
};
