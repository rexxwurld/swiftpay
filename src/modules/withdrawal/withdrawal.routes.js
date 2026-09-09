const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { validateCurrency } = require('../../middleware/currency.middleware');
const { create, list, getOne } = require('./withdrawal.controller');
router.post('/', requireApiKey, validateCurrency('currency'), create);
router.get('/', requireApiKey, list);
router.get('/:id', requireApiKey, getOne);
module.exports = router;
