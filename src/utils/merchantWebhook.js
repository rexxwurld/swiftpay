const crypto = require('crypto');

const MerchantWebhookDelivery = require(
  '../modules/webhook/merchantWebhookDelivery.model'
);

const {
  enqueueMerchantWebhookDelivery,
} = require('../queue/merchantWebhookQueue');

function signPayload(rawBody, secret) {
  return crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');
}

function getEventId(event) {
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

async function dispatchMerchantWebhook(merchant, event) {
  if (!merchant?.webhookUrl) {
    return null;
  }

  if (!merchant?.webhookSecret) {
    console.warn(
      `[merchantWebhook] merchant ${merchant._id} has webhookUrl but no webhookSecret - skipping`
    );

    return null;
  }

  const eventId = getEventId(event);

  /*
   * Generate the exact body once.
   *
   * This is important because retries must send the same signed
   * payload instead of generating a new sentAt/signature each time.
   */
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

  /*
   * Persist the delivery BEFORE putting it on Redis.
   *
   * If Redis is temporarily unavailable, the MongoDB record still
   * exists and can be redriven later.
   */
  const delivery = await MerchantWebhookDelivery.create({
    merchant: merchant._id,
    eventType: event.type,
    rawBody,
    signature,
    eventId,
    webhookUrl: merchant.webhookUrl,
    status: 'pending',
  });

  try {
    await enqueueMerchantWebhookDelivery(delivery._id);
  } catch (err) {
    /*
     * Do not delete the Mongo record.
     *
     * The delivery remains pending and can be picked up by a
     * recovery/redrive process later.
     */
    console.error(
      '[merchantWebhook] failed to enqueue durable delivery',
      err
    );
  }

  return delivery;
}

module.exports = {
  dispatchMerchantWebhook,
  signPayload,
  getEventId,
};
