// src/server.js
const app = require('./app');
const connectDB = require('./config/db');
const { port } = require('./config/env');
const { ensureDefaultBankPartners } = require('./modules/bankPartner/bankPartner.service');
const { redriveStuckEvents } = require('./modules/webhook/webhook.processor');
const { redriveStuckMerchantWebhookDeliveries } = require('./utils/merchantWebhook');
const { startWebhookWorker } = require('./queue/webhookWorker');
const {
  startMerchantWebhookWorker,
} = require('./queue/merchantWebhookWorker');

const logger = require('./utils/logger');

// How often to sweep for events/deliveries that fell off the Redis-backed
// queue (Redis was briefly down, Redis lost data, etc) and never got
// picked up by a worker. Previously this only ran once, at server boot -
// which meant anything that fell off the queue *while the server kept
// running* (not just at startup) had no recovery path until the next
// deploy/restart. Running it on a timer instead closes that gap.
const REDRIVE_SWEEP_INTERVAL_MS = Number(process.env.REDRIVE_SWEEP_INTERVAL_MINUTES || 5) * 60 * 1000;

async function runRedriveSweep() {
  try {
    const redrivenEvents = await redriveStuckEvents();
    const redrivenDeliveries = await redriveStuckMerchantWebhookDeliveries();
    if (redrivenEvents > 0 || redrivenDeliveries > 0) {
      logger.info(
        { redrivenEvents, redrivenDeliveries },
        '[server] redrive sweep restored stuck item(s) onto durable queue(s)'
      );
    }
  } catch (err) {
    logger.error({ err }, '[server] redrive sweep failed');
  }
}

async function start() {
  await connectDB();

  // Make sure the single bank partner (RexxPay Bank) exists.
  await ensureDefaultBankPartners();

  // NOTE: 'rexxpay-bank' (the REAL bank) is deliberately NOT
  // auto-provisioned here. Provisioning it calls the real RexxPay Bank
  // API and creates real wallets - doing that on every server restart
  // (which happens often on Render's free tier when the app sleeps/wakes)
  // would spam real accounts you don't need. Provision it once manually,
  // e.g. via a one-off script or an authenticated admin route, and only
  // top it up again when the pool actually runs low.

  // Run once immediately at boot (same as before), then keep running on
  // a timer for as long as the process stays up - see REDRIVE_SWEEP_INTERVAL_MS.
  await runRedriveSweep();
  setInterval(runRedriveSweep, REDRIVE_SWEEP_INTERVAL_MS);

  // Runs the BullMQ worker in the same process by default (fine for a
  // single small deployment / free-tier hosting). Set
  // WEBHOOK_WORKER_IN_PROCESS=false and run `node src/queue/webhookWorker.js`
  // as a separate process/dyno once webhook volume needs to scale
  // independently of the API.
  
  if (process.env.WEBHOOK_WORKER_IN_PROCESS !== 'false') {
  startWebhookWorker();
  startMerchantWebhookWorker();

  logger.info(
    '[server] webhook workers started in-process'
  );
  }

  app.listen(port, () => {
    logger.info({ port }, '[server] SwiftPay listening');
  });
}

start().catch((err) => {
  logger.error({ err }, '[server] failed to start');
  process.exit(1);
});
