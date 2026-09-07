// src/config/limits.js
//
// Real payment processors tier these by KYC/merchant verification level
// (e.g. CBN's tiered KYC framework for Nigerian accounts). This is a
// simple flat version - enough to demonstrate the control exists, not a
// finished compliance policy. Wire real tiering in before production.

const { getPlanConfig } = require('./plans');

const GLOBAL_DEFAULTS = {
  // Single incoming payment below this (in minor units, i.e. kobo) is
  // rejected at initialize time / flagged if it somehow still lands -
  // below this the fixed component of the platform fee (see
  // config/fees.js) eats a disproportionate, sometimes majority, share
  // of the transaction. Not plan-tiered - kept as one global floor
  // regardless of merchant plan.
  MIN_SINGLE_PAYMENT_MINOR: Number(process.env.MIN_SINGLE_PAYMENT_MINOR || 10000), // ₦100.00

  // Single incoming payment above this (in minor units, i.e. kobo) gets
  // flagged for manual review instead of auto-credited.
  MAX_SINGLE_PAYMENT_MINOR: Number(process.env.MAX_SINGLE_PAYMENT_MINOR || 500_000_00), // ₦500,000

  // Rolling 24h inbound volume per merchant above this gets flagged.
  MAX_DAILY_INBOUND_MINOR: Number(process.env.MAX_DAILY_INBOUND_MINOR || 5_000_000_00), // ₦5,000,000

  // Max number of distinct incoming payments to the same virtual account
  // within a short window - guards against rapid structuring/smurfing.
  VELOCITY_WINDOW_MINUTES: Number(process.env.VELOCITY_WINDOW_MINUTES || 10),
  VELOCITY_MAX_COUNT: Number(process.env.VELOCITY_MAX_COUNT || 5),

  // Payouts
  MAX_SINGLE_PAYOUT_MINOR: Number(process.env.MAX_SINGLE_PAYOUT_MINOR || 2_000_000_00), // ₦2,000,000
};

module.exports = {
  ...GLOBAL_DEFAULTS,

  // A virtual account that's been sitting 'assigned' with no successful
  // payment for longer than this is considered abandoned (customer never
  // paid, or paid a different way) and gets released back to the
  // available pool so a future order can reuse the account number.
  VIRTUAL_ACCOUNT_EXPIRY_MINUTES: Number(process.env.VIRTUAL_ACCOUNT_EXPIRY_MINUTES || 30),

  // How long a merchant has to submit evidence on a dispute before it's
  // eligible for resolution against them by default.
  DISPUTE_EVIDENCE_WINDOW_DAYS: Number(process.env.DISPUTE_EVIDENCE_WINDOW_DAYS || 7),

  // Automatic Pool Manager: if a bank partner's available-account count
  // drops at or below this, top it back up. Checked per-bank.
  POOL_MIN_THRESHOLD: Number(process.env.POOL_MIN_THRESHOLD || 20),

  // How many accounts to provision in one top-up pass when a bank's pool
  // is below POOL_MIN_THRESHOLD.
  POOL_TOPUP_COUNT: Number(process.env.POOL_TOPUP_COUNT || 20),

  // ================= SETTLEMENT =================
  // How long a confirmed inbound payment sits in pendingSettlementBalance
  // before it's eligible to move to `settled`. Real processors do this
  // to absorb late chargebacks/reversals from the bank side before
  // treating money as truly theirs. Default here is a conservative T+1.
  SETTLEMENT_CUTOFF_MINUTES: Number(process.env.SETTLEMENT_CUTOFF_MINUTES || 24 * 60),

  // Additional hold between `settled` and `available` (payable). Zero by
  // default - once settled, funds become payable in the same cycle.
  // Raise this if you want a second buffer specifically before money is
  // actually payable out to a real bank account.
  SETTLEMENT_AVAILABILITY_DELAY_MINUTES: Number(process.env.SETTLEMENT_AVAILABILITY_DELAY_MINUTES || 0),

  // Max transactions processed per settlement batch run, per phase. Keeps
  // a single cron tick bounded instead of trying to settle an unbounded
  // backlog in one pass if the job was down for a while.
  SETTLEMENT_BATCH_SIZE: Number(process.env.SETTLEMENT_BATCH_SIZE || 500),

  // ================= PLAN-AWARE LIMITS =================
  // Resolves the four merchant-specific limits above by layering:
  //   env-configured GLOBAL_DEFAULTS -> the merchant's plan tier
  // (src/config/plans.js) -> (future) a per-merchant override field,
  // once one exists, mirroring how merchant.fees already works.
  //
  // Pass a Merchant document (or null/undefined to just get the global
  // defaults - e.g. for a pre-merchant context).
  getLimitsForMerchant(merchant) {
    const planLimits = getPlanConfig(merchant?.plan).limits || {};
    return {
      MIN_SINGLE_PAYMENT_MINOR: GLOBAL_DEFAULTS.MIN_SINGLE_PAYMENT_MINOR, // not plan-tiered; same floor for every plan
      MAX_SINGLE_PAYMENT_MINOR: planLimits.MAX_SINGLE_PAYMENT_MINOR ?? GLOBAL_DEFAULTS.MAX_SINGLE_PAYMENT_MINOR,
      MAX_DAILY_INBOUND_MINOR: planLimits.MAX_DAILY_INBOUND_MINOR ?? GLOBAL_DEFAULTS.MAX_DAILY_INBOUND_MINOR,
      VELOCITY_WINDOW_MINUTES: GLOBAL_DEFAULTS.VELOCITY_WINDOW_MINUTES, // not plan-tiered; structuring window stays constant
      VELOCITY_MAX_COUNT: planLimits.VELOCITY_MAX_COUNT ?? GLOBAL_DEFAULTS.VELOCITY_MAX_COUNT,
      MAX_SINGLE_PAYOUT_MINOR: planLimits.MAX_SINGLE_PAYOUT_MINOR ?? GLOBAL_DEFAULTS.MAX_SINGLE_PAYOUT_MINOR,
    };
  },
};
