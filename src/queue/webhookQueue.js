// src/queue/webhookQueue.js
//
// Durable replacement for the in-process setImmediate/setTimeout retry
// loop that used to live in webhook.processor.js. Jobs are persisted
// in Redis by BullMQ, so a crash mid-retry no longer loses the event -
// any Redis-backed job survives the process restarting, unlike the old
// in-memory timers which simply vanished if the process died.
//
// This is the "seam to swap in a real queue (SQS/BullMQ)" the README
// called out - this file is that swap.

const { Queue } = require('bullmq');
const { getConnectionOptions } = require('./redisConnection');
const logger = require('../utils/logger');

const QUEUE_NAME = 'webhook-events';

const webhookQueue = new Queue(QUEUE_NAME, {
  connection: getConnectionOptions(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 }, // 2s, 4s, 8s, 16s, 32s
    removeOnComplete: { age: 24 * 60 * 60, count: 5000 }, // keep 24h for debugging
    removeOnFail: false, // keep failed jobs around for manual/ops review
  },
});

webhookQueue.on('error', (err) => {
  logger.error({ err }, '[webhookQueue] connection error');
});

/**
 * Enqueue a webhook event for durable, retried processing.
 * @param {string} eventId - Mongo _id of the persisted WebhookEvent doc.
 */
async function enqueueWebhookEvent(eventId) {
  // jobId = eventId makes re-enqueueing the same event a no-op instead
  // of creating a duplicate job (belt-and-suspenders alongside the
  // Mongo-level idempotency already in transaction.service.js).
  await webhookQueue.add('process', { eventId: eventId.toString() }, { jobId: eventId.toString() });
}

module.exports = { webhookQueue, enqueueWebhookEvent, QUEUE_NAME };
