// src/modules/settlement/settlement.routes.js
const express = require('express');
const router = express.Router();
const requireAdminKey = require('../../middleware/adminKey.middleware');
const { runCycle, batches } = require('./settlement.controller');

// POST /api/v1/admin/settlement/run?currency=NGN - force a settlement cycle now.
router.post('/run', requireAdminKey, runCycle);

// GET /api/v1/admin/settlement/batches - inspect recent settlement batches.
router.get('/batches', requireAdminKey, batches);

module.exports = router;
