// src/config/fees.js
const DEFAULT_FEE = {
  percentageBps: parseInt(process.env.PLATFORM_FEE_BPS || '150', 10),
  fixedMinor: parseInt(process.env.PLATFORM_FEE_FIXED_MINOR || '10000', 10),
  capMinor: parseInt(process.env.PLATFORM_FEE_CAP_MINOR || '200000', 10),
  waiveFixedBelowMinor: parseInt(process.env.PLATFORM_FEE_WAIVE_BELOW_MINOR || '250000', 10), // NGN 2,500
};

module.exports = { DEFAULT_FEE };
