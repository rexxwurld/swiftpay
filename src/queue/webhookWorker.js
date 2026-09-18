// src/queue/webhookWorker.js
//
// BullMQ worker that actually runs webhook.processor.js's processEvent
// for each durable job. Start this alongside (or instead of in-process
// with) the main server - e.g. `node src/queue/webhookWorker.js` as its
// own process/dyno, which is the standard way to scale queue consumers
// independently of the API.

const { Worker } = require('bullmq');
const { getConnectionOptions } = require('./redisConnection');
const { QUEUE_NAME } = require('./webhookQueue');
const { processEvent } = require('../modules/webhook/webhook.processor');
const logger = require('../utils/logger');

function startWebhookWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      await processEvent(job.data.eventId);
    },
    {
      connection: getConnectionOptions(),
      concurrency: Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 5),
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, '[webhookWorker] event processed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, '[webhookWorker] event processing failed');
  });

  return worker;
}

// Allow running standalone: `node src/queue/webhookWorker.js`
if (require.main === module) {
  require('dotenv').config();
  const connectDB = require('../config/db');
  connectDB()
    .then(() => {
      startWebhookWorker();
      logger.info('[webhookWorker] worker started');
    })
    .catch((err) => {
      logger.error({ err }, '[webhookWorker] failed to start');
      process.exit(1);
    });
}

module.exports = { startWebhookWorker };
