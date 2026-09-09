// src/server.js
const app = require('./app');
const connectDB = require('./config/db');
const { port } = require('./config/env');
const { ensureDefaultBankPartners } = require('./modules/bankPartner/bankPartner.service');
const { redriveStuckEvents } = require('./modules/webhook/webhook.processor');
const { startWebhookWorker } = require('./queue/webhookWorker');
const {
  startMerchantWebhookWorker,
} = require('./queue/merchantWebhookWorker');

const logger = require('./utils/logger');

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

  // Redis-backed events (queue/webhookQueue.js) survive a crash on
  // their own now. This sweep only catches the edge case of an event
  // that was persisted in Mongo but never made it onto the queue (e.g.
  // Redis was briefly unreachable at enqueue time).
  const redriven = await redriveStuckEvents();
  if (redriven > 0) logger.info({ redriven }, '[server] redrove stuck webhook event(s) onto durable queue');

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
