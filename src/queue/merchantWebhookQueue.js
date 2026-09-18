const { Queue } = require('bullmq');
const { getConnectionOptions } = require('./redisConnection');
const logger = require('../utils/logger');

const QUEUE_NAME = 'merchant-webhook-deliveries';

const merchantWebhookQueue = new Queue(QUEUE_NAME, {
  connection: getConnectionOptions(),

  defaultJobOptions: {
    attempts: 5,

    backoff: {
      type: 'exponential',
      delay: 2000,
    },

    removeOnComplete: {
      age: 24 * 60 * 60,
      count: 5000,
    },

    removeOnFail: false,
  },
});

merchantWebhookQueue.on('error', (err) => {
  logger.error(
    { err },
    '[merchantWebhookQueue] connection error'
  );
});

async function enqueueMerchantWebhookDelivery(deliveryId) {
  const id = deliveryId.toString();

  await merchantWebhookQueue.add(
    'deliver',
    {
      deliveryId: id,
    },
    {
      jobId: id,
    }
  );
}

module.exports = {
  merchantWebhookQueue,
  enqueueMerchantWebhookDelivery,
  QUEUE_NAME,
};
