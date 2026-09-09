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

// Persists the event, then hands it to the durable Redis-backed BullMQ queue.
async function enqueue({ rawBody, signature, providerEventId }) {  const event = await WebhookEvent.create({
    rawBody,
    signature,
  providerEventId,
    status: "queued",
  });

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
  const event = await WebhookEvent.findById(eventId);

  if (!event || event.status === "processed") {
    return;
  }

  event.status = "processing";
  event.attempts += 1;

  await event.save();

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

    // The SwiftPay-side virtual account must still be assigned.
    //
    // The BANK itself is responsible for immediately deactivating the
    // actual bank account when the money arrives. This check protects
    // SwiftPay from accepting another payment against an account that
    // SwiftPay has already consumed/released.
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
      //
      // IMPORTANT:
      //
      // The BANK is supposed to deactivate its real bank account
      // immediately when the deposit arrives.
      //
      // This call only deactivates SwiftPay's LOCAL virtual-account
      // record so SwiftPay's pool state matches the completed checkout.
      //
      // It is intentionally done AFTER the transaction is recorded.
      // If it fails, the payment itself is NOT rolled back.
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

        // The payment has already been recorded successfully.
        //
        // DO NOT throw here.
        //
        // Throwing would cause BullMQ to retry the webhook even though
        // the transaction already exists.
        //
        // The bank is independently responsible for deactivating its
        // actual account immediately after receiving the money.
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
            { err },
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
