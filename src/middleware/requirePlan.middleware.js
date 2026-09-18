// src/middleware/requirePlan.middleware.js
//
// Gates a route to merchants whose plan includes a given feature (see
// src/config/plans.js). Must run after requireApiKey/requireApiKey-style
// auth middleware, since it reads req.merchant.plan - it does not fetch
// the merchant itself.
//
// Usage:
//   router.post('/', requireApiKey, requirePlan('subaccounts'), create);

const { planHasFeature } = require('../config/plans');

function requirePlan(featureName) {
  return function (req, res, next) {
    if (!req.merchant) {
      return res.status(401).json({ status: false, message: 'missing_api_key' });
    }

    if (!planHasFeature(req.merchant.plan, featureName)) {
      return res.status(403).json({
        status: false,
        message: `feature_not_available_on_current_plan`,
        feature: featureName,
        currentPlan: req.merchant.plan || 'starter',
      });
    }

    return next();
  };
}

module.exports = requirePlan;
