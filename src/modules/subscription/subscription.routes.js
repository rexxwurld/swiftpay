// src/modules/subscription/subscription.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { validateCurrency } = require('../../middleware/currency.middleware');
const {
  createPlanHandler,
  listPlansHandler,
  subscribeHandler,
  listSubscriptionsHandler,
  cancelHandler,
  listInvoicesHandler,
} = require('./subscription.controller');

router.post('/plans', requireApiKey, validateCurrency('currency'), createPlanHandler);
router.get('/plans', requireApiKey, listPlansHandler);

router.post('/', requireApiKey, subscribeHandler);
router.get('/', requireApiKey, listSubscriptionsHandler);
router.post('/:id/cancel', requireApiKey, cancelHandler);

router.get('/invoices', requireApiKey, listInvoicesHandler);

module.exports = router;
