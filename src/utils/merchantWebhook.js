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

// Re-enqueue any delivery that's sitting in 'pending' or 'delivering' in
// Mongo but may have fallen out of the Redis-backed queue (Redis was down
// at enqueue time, Redis itself restarted/lost data, etc). Re-adding an
// already-queued job is a safe no-op - enqueueMerchantWebhookDelivery uses
// the delivery's own _id as the BullMQ job ID, so this never creates a
// duplicate delivery, it only restores ones that fell off the queue.
//
// Meant to be called periodically (see src/server.js), not just once at
// boot - a delivery can fall off the queue at any point while the server
// keeps running, not only at startup.
async function redriveStuckMerchantWebhookDeliveries() {
  const stuck = await MerchantWebhookDelivery.find({
    status: { $in: ['pending', 'delivering'] },
  });

  for (const delivery of stuck) {
    await enqueueMerchantWebhookDelivery(delivery._id).catch((err) => {
      console.error(
        '[merchantWebhook] failed to redrive stuck delivery onto durable queue',
        { deliveryId: delivery._id.toString(), err }
      );
    });
  }

  return stuck.length;
}

module.exports = {
  dispatchMerchantWebhook,
  signPayload,
  getEventId,
  redriveStuckMerchantWebhookDeliveries,
};
