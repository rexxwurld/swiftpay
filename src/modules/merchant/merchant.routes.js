// src/modules/merchant/merchant.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { profile, updateWebhook, regenerateKey, regenerateWebhook } = require('./merchant.controller');

router.get('/me', requireApiKey, profile);
router.patch('/webhook-url', requireApiKey, updateWebhook);
router.post('/regenerate-key', requireApiKey, regenerateKey);
router.post('/regenerate-webhook-secret', requireApiKey, regenerateWebhook);

module.exports = router;
