const express = require('express');

const router = express.Router();

const {
  getStatus,
  simulate,
  complete,
} = require('./checkout.controller');

// Public checkout endpoints.
// No merchant API key is required because the customer is not
// supposed to possess the merchant's secret key.

router.get(
  '/:token/status',
  getStatus
);

// TEST-mode only (enforced in the controller) - lets pay.html's
// "simulate transfer" button stand in for a real bank transfer.
router.post(
  '/:token/simulate',
  simulate
);

router.get(
  '/:token/complete',
  complete
);

module.exports = router;
