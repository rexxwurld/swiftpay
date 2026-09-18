// src/modules/wallet/wallet.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { getWallet, getAllWallets } = require('./wallet.controller');

router.get('/all', requireApiKey, getAllWallets);
router.get('/', requireApiKey, getWallet);

module.exports = router;
