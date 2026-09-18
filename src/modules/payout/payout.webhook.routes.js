const express = require('express');
const router = express.Router();
const { receivePayoutWebhook } = require('./payout.webhook.controller');
router.post('/', receivePayoutWebhook);
module.exports = router;
