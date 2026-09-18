// src/modules/demo/demo.routes.js
const express = require('express');
const router = express.Router();
const { startCheckout } = require('./demo.controller');

// Deliberately no requireApiKey - this is the one endpoint in the app a
// visitor with no account is meant to be able to call. It always runs
// in test mode against a single dedicated demo merchant (see
// demo.service.js) - never a real merchant's account or real money.
// Rate-limited at the router mount in app.js (see demoLimiter).
router.post('/checkout', startCheckout);

module.exports = router;
