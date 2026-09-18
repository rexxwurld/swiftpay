// src/modules/bankPartner/bank.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { accountResolutionLimiter } = require('../../middleware/rateLimit.middleware');
const { getBanks, resolveAccount } = require('./bank.controller');

router.get('/banks', requireApiKey, getBanks);
router.post('/bank/accounts/resolve', accountResolutionLimiter, requireApiKey, resolveAccount);

module.exports = router;
