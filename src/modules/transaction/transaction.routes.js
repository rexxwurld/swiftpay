// src/modules/transaction/transaction.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { list } = require('./transaction.controller');

router.get('/', requireApiKey, list);

module.exports = router;
