// src/modules/dispute/dispute.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const requireAdminKey = require('../../middleware/adminKey.middleware');
const { create, list, getOne, addEvidence, resolve } = require('./dispute.controller');

// Merchant-visible: their own disputes, and evidence submission.
router.get('/', requireApiKey, list);
router.get('/:id', requireApiKey, getOne);
router.post('/:id/evidence', requireApiKey, addEvidence);

// Ops-only: opening a dispute (a chargeback notice arriving from outside)
// and resolving one. Never merchant-callable - a merchant deciding its
// own chargeback outcome defeats the point.
router.post('/', requireAdminKey, create);
router.post('/:id/resolve', requireAdminKey, resolve);

module.exports = router;
