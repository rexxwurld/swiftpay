// src/modules/subaccount/subaccount.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const requirePlan = require('../../middleware/requirePlan.middleware');
const { create, list, getOne, settle } = require('./subaccount.controller');

// Creating/settling a split requires a plan that includes subaccounts
// (Growth or Enterprise - see src/config/plans.js). Reading existing
// subaccounts stays open to any plan, same as before, so a merchant who
// downgrades can still see historical data rather than losing visibility
// into it.
router.post('/', requireApiKey, requirePlan('subaccounts'), create);
router.get('/', requireApiKey, list);
router.get('/:id', requireApiKey, getOne);
router.post('/:id/settle', requireApiKey, requirePlan('subaccounts'), settle);

module.exports = router;
