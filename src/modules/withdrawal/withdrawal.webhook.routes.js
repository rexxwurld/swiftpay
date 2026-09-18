const express = require('express');
const router = express.Router();
const { receiveWithdrawalWebhook } = require('./withdrawal.webhook.controller');
router.post('/', receiveWithdrawalWebhook);
module.exports = router;
