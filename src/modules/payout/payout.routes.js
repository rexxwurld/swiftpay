// src/modules/payout/payout.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { validateCurrency } = require('../../middleware/currency.middleware');
const { moneyMovementLimiter } = require('../../middleware/rateLimit.middleware');
const { create, createBulk, list } = require('./payout.controller');

router.post('/', moneyMovementLimiter, requireApiKey, validateCurrency('currency'), create);
router.post('/bulk', moneyMovementLimiter, requireApiKey, validateCurrency('currency'), createBulk);
router.get('/', requireApiKey, list);

module.exports = router;
