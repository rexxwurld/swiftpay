const axios = require('axios');
const { Worker } = require('bullmq');

const {
  getConnectionOptions,
} = require('./redisConnection');

const {
  QUEUE_NAME,
} = require('./merchantWebhookQueue');

const MerchantWebhookDelivery = require(
  '../modules/webhook/merchantWebhookDelivery.model'
);

const auditLog = require(
  '../modules/audit/auditLog.service'
);

const logger = require('../utils/logger');

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 8000;

/*
 * A delivery that stays in "delivering" longer than this is
 * considered abandoned and may be reclaimed.
 */
const STALE_DELIVERY_MS = 10 * 60 * 1000;

async function claimDelivery(deliveryId) {
  const staleBefore = new Date(
    Date.now() - STALE_DELIVERY_MS
  );

  return MerchantWebhookDelivery.findOneAndUpdate(
    {
      _id: deliveryId,

      $or: [
        {
          status: 'pending',
        },
        {
          status: 'delivering',
          processingStartedAt: {
            $lt: staleBefore,
          },
        },
      ],
    },
    {
      $set: {
        status: 'delivering',
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
}

async function deliverMerchantWebhook(deliveryId) {
  const delivery = await claimDelivery(deliveryId);

  /*
   * Another worker may already be delivering it.
   * In that case, do nothing.
   */
  if (!delivery) {
    return;
  }

  try {
    await axios.post(
      delivery.webhookUrl,
      delivery.rawBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-SwiftPay-Signature': delivery.signature,
          'X-SwiftPay-Event-Id': delivery.eventId,
        },

        timeout: TIMEOUT_MS,

        validateStatus: (status) =>
          status >= 200 && status < 300,
      }
    );

    await MerchantWebhookDelivery.findByIdAndUpdate(
      delivery._id,
      {
        $set: {
          status: 'delivered',
          deliveredAt: new Date(),
        },

        $unset: {
          lastError: '',
          processingStartedAt: '',
          nextAttemptAt: '',
        },
      }
    );

    logger.info(
      {
        deliveryId: delivery._id.toString(),
        merchantId: delivery.merchant.toString(),
        eventId: delivery.eventId,
      },
      '[merchantWebhookWorker] merchant webhook delivered'
    );
  } catch (err) {
    const permanentFailure =
      delivery.attempts >= MAX_ATTEMPTS;

    if (permanentFailure) {
      await MerchantWebhookDelivery.findByIdAndUpdate(
        delivery._id,
        {
          $set: {
            status: 'failed',
            lastError: err.message,
          },

          $unset: {
            processingStartedAt: '',
            nextAttemptAt: '',
          },
        }
      );

      await auditLog.record({
        actorType: 'system',
        actorRef: 'merchant_webhook_worker',
        action: 'merchant_webhook.delivery_failed_permanently',
        severity: 'critical',
        metadata: {
          deliveryId: delivery._id.toString(),
          merchantId: delivery.merchant.toString(),
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          attempts: delivery.attempts,
          error: err.message,
        },
      });

      logger.error(
        {
          deliveryId: delivery._id.toString(),
          eventId: delivery.eventId,
          err,
        },
        '[merchantWebhookWorker] permanent delivery failure'
      );

      return;
    }

    /*
     * Put it back into pending.
     *
     * BullMQ will perform the retry using its durable
     * exponential backoff configuration.
     */
    await MerchantWebhookDelivery.findByIdAndUpdate(
      delivery._id,
      {
        $set: {
          status: 'pending',
          lastError: err.message,
          nextAttemptAt: new Date(
            Date.now() +
              2000 * Math.pow(2, delivery.attempts - 1)
          ),
        },

        $unset: {
          processingStartedAt: '',
        },
      }
    );

    throw err;
  }
}

function startMerchantWebhookWorker() {
  const worker = new Worker(
    QUEUE_NAME,

    async (job) => {
      await deliverMerchantWebhook(
        job.data.deliveryId
      );
    },

    {
      connection: getConnectionOptions(),

      concurrency: Number(
        process.env.MERCHANT_WEBHOOK_WORKER_CONCURRENCY || 5
      ),
    }
  );

  worker.on('completed', (job) => {
    logger.info(
      { jobId: job.id },
      '[merchantWebhookWorker] delivery job completed'
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      '[merchantWebhookWorker] delivery job failed'
    );
  });

  return worker;
}

if (require.main === module) {
  require('dotenv').config();

  const connectDB = require('../config/db');

  connectDB()
    .then(() => {
      startMerchantWebhookWorker();

      logger.info(
        '[merchantWebhookWorker] worker started'
      );
    })
    .catch((err) => {
      logger.error(
        { err },
        '[merchantWebhookWorker] failed to start'
      );

      process.exit(1);
    });
}

module.exports = {
  startMerchantWebhookWorker,
  deliverMerchantWebhook,
};
