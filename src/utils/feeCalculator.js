// src/utils/feeCalculator.js
const { DEFAULT_FEE } = require('../config/fees');
const { getPlanConfig } = require('../config/plans');

function computeFee(amountMinor, merchant = null) {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error('invalid_fee_base_amount');
  }

  const plan = getPlanConfig(merchant?.plan).fees;
  const override = merchant?.fees || {};

  const percentageBps = Number.isFinite(override.percentageBps)
    ? override.percentageBps
    : Number.isFinite(plan.percentageBps)
      ? plan.percentageBps
      : DEFAULT_FEE.percentageBps;

  const fixedMinor = Number.isFinite(override.fixedMinor)
    ? override.fixedMinor
    : Number.isFinite(plan.fixedMinor)
      ? plan.fixedMinor
      : DEFAULT_FEE.fixedMinor;

  const capMinor = Number.isFinite(override.capMinor)
    ? override.capMinor
    : Number.isFinite(plan.capMinor)
      ? plan.capMinor
      : DEFAULT_FEE.capMinor;

  const waiveFixedBelowMinor = Number.isFinite(override.waiveFixedBelowMinor)
    ? override.waiveFixedBelowMinor
    : Number.isFinite(plan.waiveFixedBelowMinor)
      ? plan.waiveFixedBelowMinor
      : DEFAULT_FEE.waiveFixedBelowMinor;

  const applyFixed = amountMinor >= waiveFixedBelowMinor;

  let feeAmount = Math.floor((amountMinor * percentageBps) / 10000) + (applyFixed ? fixedMinor : 0);

  if (capMinor > 0) {
    feeAmount = Math.min(feeAmount, capMinor);
  }

  feeAmount = Math.max(0, Math.min(feeAmount, amountMinor));

  const netAmount = amountMinor - feeAmount;
  return { feeAmount, netAmount };
}

module.exports = { computeFee };
