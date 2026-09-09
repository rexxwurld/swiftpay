// src/utils/merchantWebhook.js

const crypto = require('crypto');
const axios = require('axios');
const auditLog = require('../modules/audit/auditLog.service');

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 8000;

function signPayload(rawBody, secret) {
  return crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');
}

function getEventId(event) {
  /*
   * Prefer an ID supplied by the caller.
   *
   * If none exists, generate a deterministic ID from the event data.
   * This means retries of the same event can use the same ID.
   */
  if (event?.id) {
    return String(event.id);
  }

  if (event?.eventId) {
    return String(event.eventId);
  }

  const source = JSON.stringify({
    type: event?.type || '',
    data: event?.data || {},
  });

  return crypto
    .createHash('sha256')
    .update(source)
    .digest('hex');
}

async function dispatchMerchantWebhook(merchant, event, attempt = 1) {
  if (!merchant?.webhookUrl) return;

  if (!merchant?.webhookSecret) {
    console.warn(
      `[merchantWebhook] merchant ${merchant._id} has webhookUrl but no webhookSecret - skipping`
    );
    return;
  }

  const eventId = getEventId(event);

  const rawBody = JSON.stringify({
    id: eventId,
    event: event.type,
    data: event.data,
    sentAt: new Date().toISOString(),
  });

  const signature = signPayload(
    rawBody,
    merchant.webhookSecret
  );

  try {
    await axios.post(merchant.webhookUrl, rawBody, {
      headers: {
        'Content-Type': 'application/json',
        'X-SwiftPay-Signature': signature,
        'X-SwiftPay-Event-Id': eventId,
      },
      timeout: TIMEOUT_MS,
      validateStatus: (status) =>
        status >= 200 && status < 300,
    });
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) {
      await auditLog.record({
        actorType: 'system',
        actorRef: 'merchant_webhook_dispatcher',
        action: 'merchant_webhook.delivery_failed_permanently',
        severity: 'critical',
        metadata: {
          merchantId: merchant._id.toString(),
          eventType: event.type,
          eventId,
          error: err.message,
        },
      });

      return;
    }

    const backoffMs = 2000 * attempt;

    setTimeout(() => {
      dispatchMerchantWebhook(
        merchant,
        {
          ...event,
          eventId,
        },
        attempt + 1
      ).catch(() => {});
    }, backoffMs);
  }
}

module.exports = {
  dispatchMerchantWebhook,
  signPayload,
};
