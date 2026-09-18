// src/modules/refund/refund.webhook.routes.js
const express = require('express');
const router = express.Router();
const { receiveRefundWebhook } = require('./refund.webhook.controller');

// In production this URL is only known to your bank partner and should
// also be IP-allowlisted in addition to signature verification, same as
// /webhooks/bank in webhook.routes.js.
router.post('/', receiveRefundWebhook);

module.exports = router;
