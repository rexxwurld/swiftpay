// src/modules/refund/refund.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { moneyMovementLimiter } = require('../../middleware/rateLimit.middleware');
const { create, list, getOne } = require('./refund.controller');

router.post('/', moneyMovementLimiter, requireApiKey, create);
router.get('/', requireApiKey, list);
router.get('/:id', requireApiKey, getOne);

module.exports = router;
