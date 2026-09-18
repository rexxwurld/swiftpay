// src/modules/webhook/webhook.routes.js
const express = require('express');
const router = express.Router();
const { receiveBankWebhook } = require('./webhook.controller');

// In production this URL is only known to your bank partner and should
// also be IP-allowlisted in addition to signature verification.
router.post('/bank', receiveBankWebhook);

module.exports = router;
