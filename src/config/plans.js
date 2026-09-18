// src/config/plans.js
//
// Until now, Merchant.plan was stored at signup but never read anywhere -
// every merchant got the exact same fees, limits, and feature access
// regardless of what they picked. This file is what actually makes the
// plan mean something.
//
// Resolution order (highest precedence last) is the same pattern already
// used for fees: global default -> plan tier -> per-merchant override.
// A per-merchant `merchant.fees` override (already existed) still wins
// over the plan's fee, for negotiated one-off deals - the plan sets the
// *default* a merchant on that tier gets, not a hard ceiling.
//
// These numbers are placeholders for the business to tune, not
// researched pricing - the point of this file is that the mechanism now
// exists at all.

const PLANS = {
  starter: {
    fees: {
      percentageBps: 150, // 1.5%
      fixedMinor: 10000, // NGN 100.00
      capMinor: 200000, // NGN 2,000.00
    },
    limits: {
      MAX_SINGLE_PAYMENT_MINOR: 500_000_00, // NGN 500,000
      MAX_DAILY_INBOUND_MINOR: 5_000_000_00, // NGN 5,000,000
      VELOCITY_MAX_COUNT: 5,
      MAX_SINGLE_PAYOUT_MINOR: 2_000_000_00, // NGN 2,000,000
    },
    features: {
      subaccounts: false,
      recipients: true,
      subscriptions: true,
    },
  },

  growth: {
    fees: {
      percentageBps: 120, // 1.2%
      fixedMinor: 7500, // NGN 75.00
      capMinor: 200000,
    },
    limits: {
      MAX_SINGLE_PAYMENT_MINOR: 2_000_000_00, // NGN 2,000,000
      MAX_DAILY_INBOUND_MINOR: 20_000_000_00, // NGN 20,000,000
      VELOCITY_MAX_COUNT: 10,
      MAX_SINGLE_PAYOUT_MINOR: 5_000_000_00, // NGN 5,000,000
    },
    features: {
      subaccounts: true,
      recipients: true,
      subscriptions: true,
    },
  },

  enterprise: {
    fees: {
      percentageBps: 90, // 0.9%
      fixedMinor: 5000, // NGN 50.00
      capMinor: 300000, // NGN 3,000.00
    },
    limits: {
      MAX_SINGLE_PAYMENT_MINOR: 10_000_000_00, // NGN 10,000,000
      MAX_DAILY_INBOUND_MINOR: 100_000_000_00, // NGN 100,000,000
      VELOCITY_MAX_COUNT: 20,
      MAX_SINGLE_PAYOUT_MINOR: 20_000_000_00, // NGN 20,000,000
    },
    features: {
      subaccounts: true,
      recipients: true,
      subscriptions: true,
    },
  },
};

function getPlanConfig(planName) {
  return PLANS[planName] || PLANS.starter;
}

function planHasFeature(planName, featureName) {
  const plan = getPlanConfig(planName);
  return !!plan.features?.[featureName];
}

module.exports = { PLANS, getPlanConfig, planHasFeature };
