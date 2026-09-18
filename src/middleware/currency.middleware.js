// src/middleware/currency.middleware.js
//
// Rejects requests that name an unsupported currency before they touch
// any service logic. Use on any route where the CLIENT supplies a
// currency (payouts, refunds, plans) - never needed on webhook-driven
// paths, since those currencies come from the bank partner, not a client.

const { isSupportedCurrency } = require('../config/currencies');

function validateCurrency(fieldPath = 'currency', { required = false } = {}) {
  return function currencyMiddleware(req, res, next) {
    const value = req.body?.[fieldPath];

    if (value == null || value === '') {
      if (required) {
        return res.status(400).json({ status: false, message: `${fieldPath}_required` });
      }
      return next();
    }

    if (!isSupportedCurrency(value)) {
      return res.status(400).json({
        status: false,
        message: `unsupported_currency:${value}`,
      });
    }

    req.body[fieldPath] = String(value).toUpperCase();
    next();
  };
}

module.exports = { validateCurrency };
