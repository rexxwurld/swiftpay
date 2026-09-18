// src/modules/payment/payment.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { paymentLimiter } = require('../../middleware/rateLimit.middleware');
const { initialize, verify } = require('./payment.controller');

router.post('/initialize', paymentLimiter, requireApiKey, initialize);
router.get('/verify/:tx_ref', paymentLimiter, requireApiKey, verify);

module.exports = router;
