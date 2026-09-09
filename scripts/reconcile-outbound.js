// scripts/reconcile-outbound.js
//
// Companion to scripts/reconcile.js, but for money going OUT instead of
// coming in. A payout/withdrawal/refund can get stuck in 'processing' or
// 'ambiguous' if RexxPay Bank's confirmation webhook never arrives (bank
// outage, dropped webhook, etc) - see the audit report, Must-Fix #2.
//
// This script finds anything stuck longer than STUCK_AFTER_MINUTES,
// actively asks RexxPay Bank what really happened (via checkPayoutStatus /
// checkRefundStatus), and applies the real outcome through the exact same
// confirm*Outcome() functions the webhooks themselves use - so this is not
// a new, separate code path for finalizing money, it just supplies the
// missing trigger when the webhook trigger never came.
//
// Only checks LIVE-mode records. Test mode never truly gets stuck (the
// simulated bank client always resolves synchronously), and there is no
// simulated status-check endpoint to call for it.
//
// Usage:
//   node scripts/reconcile-outbound.js
//   node scripts/reconcile-outbound.js --minutes=15   (override the default wait)

require('dotenv').config();
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');

const Payout = require('../src/modules/payout/payout.model');
const Withdrawal = require('../src/modules/withdrawal/withdrawal.model');
const Refund = require('../src/modules/refund/refund.model');

const { confirmPayoutOutcome } = require('../src/modules/payout/payout.service');
const { confirmWithdrawalOutcome } = require('../src/modules/withdrawal/withdrawal.service');
const { confirmRefundOutcome } = require('../src/modules/refund/refund.service');

const { checkPayoutStatus, checkRefundStatus } = require('../src/modules/bankPartner/rexxPayBankClient');

const STUCK_AFTER_MINUTES = Number(
  (process.argv.find((a) => a.startsWith('--minutes=')) || '').split('=')[1]
) || 30;

const STUCK_STATUSES = ['processing', 'ambiguous'];

async function reconcilePayouts(cutoff) {
  const stuck = await Payout.find({
    mode: 'live',
    status: { $in: STUCK_STATUSES },
    updatedAt: { $lte: cutoff },
  });

  const results = [];
  for (const payout of stuck) {
    try {
      const outcome = await checkPayoutStatus(payout.reference);
      if (!outcome.found || !outcome.final) {
        results.push({ reference: payout.reference, action: 'still_unresolved' });
        continue;
      }
      await confirmPayoutOutcome({
        reference: payout.reference,
        success: outcome.success,
        providerRef: outcome.providerReference,
        failureReason: outcome.failureReason,
      });
      results.push({ reference: payout.reference, action: outcome.success ? 'resolved_successful' : 'resolved_failed' });
    } catch (err) {
      results.push({ reference: payout.reference, action: 'error', error: err.message });
    }
  }
  return results;
}

async function reconcileWithdrawals(cutoff) {
  const stuck = await Withdrawal.find({
    mode: 'live',
    status: { $in: STUCK_STATUSES },
    updatedAt: { $lte: cutoff },
  });

  const results = [];
  for (const withdrawal of stuck) {
    try {
      // Withdrawals submit through the same RexxPay Bank payout endpoint
      // as payouts (see withdrawal.service.js), so the same status-check
      // call applies.
      const outcome = await checkPayoutStatus(withdrawal.reference);
      if (!outcome.found || !outcome.final) {
        results.push({ reference: withdrawal.reference, action: 'still_unresolved' });
        continue;
      }
      await confirmWithdrawalOutcome({
        reference: withdrawal.reference,
        success: outcome.success,
        providerRef: outcome.providerReference,
        failureReason: outcome.failureReason,
      });
      results.push({ reference: withdrawal.reference, action: outcome.success ? 'resolved_successful' : 'resolved_failed' });
    } catch (err) {
      results.push({ reference: withdrawal.reference, action: 'error', error: err.message });
    }
  }
  return results;
}

async function reconcileRefunds(cutoff) {
  const stuck = await Refund.find({
    mode: 'live',
    status: { $in: ['pending', 'submitted'] }, // refund's own "still waiting" statuses
    updatedAt: { $lte: cutoff },
  });

  const results = [];
  for (const refund of stuck) {
    try {
      const outcome = await checkRefundStatus(refund.reference);
      if (!outcome.found || !outcome.final) {
        results.push({ reference: refund.reference, action: 'still_unresolved' });
        continue;
      }
      await confirmRefundOutcome({
        reference: refund.reference,
        success: outcome.success,
        providerRef: outcome.providerReference,
        failureReason: outcome.failureReason,
      });
      results.push({ reference: refund.reference, action: outcome.success ? 'resolved_successful' : 'resolved_failed' });
    } catch (err) {
      results.push({ reference: refund.reference, action: 'error', error: err.message });
    }
  }
  return results;
}

async function main() {
  await mongoose.connect(mongoUri);

  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000);

  const [payouts, withdrawals, refunds] = await Promise.all([
    reconcilePayouts(cutoff),
    reconcileWithdrawals(cutoff),
    reconcileRefunds(cutoff),
  ]);

  const report = { generatedAt: new Date().toISOString(), stuckAfterMinutes: STUCK_AFTER_MINUTES, payouts, withdrawals, refunds };
  console.log(JSON.stringify(report, null, 2));

  const stillUnresolved = [...payouts, ...withdrawals, ...refunds].filter((r) => r.action === 'still_unresolved' || r.action === 'error').length;
  if (stillUnresolved > 0) {
    console.error(`\n[reconcile-outbound] ${stillUnresolved} record(s) still need attention - see the report above.`);
    process.exitCode = 1;
  } else {
    console.log('\n[reconcile-outbound] clean - nothing left stuck.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[reconcile-outbound] failed:', err);
  process.exit(1);
});
