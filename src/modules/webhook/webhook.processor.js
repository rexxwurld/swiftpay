// src/modules/webhook/webhook.processor.js

const WebhookEvent = require("./webhookEvent.model");

const {
  findByAccountNumber,
  deactivateVirtualAccount,
} = require("../virtualAccount/virtualAccount.service");

const {
  recordIncomingPayment,
} = require("../transaction/transaction.service");

const Merchant = require("../merchant/merchant.model");

const {
  dispatchMerchantWebhook,
} = require("../../utils/merchantWebhook");

const {
  markInvoicePaidByTransaction,
} = require("../subscription/subscription.service");

const auditLog = require("../audit/auditLog.service");
const logger = require("../../utils/logger");

const {
  enqueueWebhookEvent,
} = require("../../queue/webhookQueue");

const MAX_ATTEMPTS = 5;

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
   */
  const event = await WebhookEvent.findOneAndUpdate(
    {
      _id: eventId,
      status: "queued",
    },
    {
      $set: {
        status: "processing",
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
     * Only perform the post-payment actions when this is a new
     * transaction.
     *
     * recordIncomingPayment already protects the financial transaction
     * itself using its unique reference/idempotency logic.
     */
    if (
      !duplicate &&
      (
        transaction.status === "success" ||
        transaction.status === "over"
      )
    ) {
      // ============================================================
      // SWIFTPAY-SIDE ACCOUNT DEACTIVATION
      // ============================================================

      try {
        await deactivateVirtualAccount({
          merchantId: merchantId._id || merchantId,
          accountNumber,
        });

        logger.info(
          { accountNumber },
          "[webhook.processor] SwiftPay virtual account marked deactivated after payment"
        );
      } catch (deactivateError) {
        /*
         * The payment has already been recorded successfully.
         *
         * Do NOT throw here.
         *
         * Throwing would cause the webhook to be retried even though
         * the financial transaction already exists.
         */
        logger.error(
          {
            accountNumber,
            err: deactivateError,
          },
          "[webhook.processor] FAILED TO MARK SWIFTPAY VIRTUAL ACCOUNT DEACTIVATED"
        );

        await auditLog.record({
          actorType: "system",
          actorRef: "webhook_processor",
          action: "virtual_account.deactivation_failed",
          severity: "critical",
          metadata: {
            accountNumber,
            transactionId: transaction._id.toString(),
            bankReference,
            error: deactivateError.message,
          },
        });
      }

      // ============================================================
      // MERCHANT WEBHOOK
      // ============================================================

      const merchant = await Merchant.findById(merchantId);

      if (merchant) {
        dispatchMerchantWebhook(merchant, {
          type: "transaction.success",
          data: {
            ...transaction.toObject(),

            // Merchant's original payment reference.
            tx_ref: merchantReference,
          },
        }).catch((err) => {
          logger.error(
            {
              err,
              transactionId: transaction._id.toString(),
            },
            "[webhook.processor] merchant webhook dispatch failed"
          );
        });
      }

      // ============================================================
      // SUBSCRIPTION INVOICE RECONCILIATION
      // ============================================================

      markInvoicePaidByTransaction(transaction).catch((err) => {
        logger.error(
          {
            err,
            transactionId: transaction._id.toString(),
          },
          "[webhook.processor] failed to reconcile invoice for transaction"
        );
      });
    }

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

module.exports = {
  enqueue,
  processEvent,
  redriveStuckEvents,
};
