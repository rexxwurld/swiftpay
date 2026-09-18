// src/modules/admin/admin.routes.js
//
// Lets you (the operator) provision the account pool and check its status
// via a plain HTTP call instead of running a script over SSH/Shell/Termux.
// Guarded by INFRA_ADMIN_KEY - never exposed to merchants.

const express = require('express');
const router = express.Router();
const requireAdminKey = require('../../middleware/adminKey.middleware');
const requireCronKey = require('../../middleware/cronKey.middleware');
const { requireAdminRole } = require('../../middleware/adminAuth.middleware');
const { loginAdmin } = require('./adminAuth.service');
const auditLog = require('../audit/auditLog.service');
const { list: listAuditLogs } = require('../audit/auditLog.service');
const WebhookEvent = require('../webhook/webhookEvent.model');
const { redriveFailedEvent } = require('../webhook/webhook.processor');
const { CronHeartbeat, recordHeartbeat } = require('./cronHeartbeat.model');
const { resolveFlaggedTransaction } = require('../transaction/transaction.service');

// How often each cron job is *expected* to run - used only to flag
// staleness in GET /cron/health, does not affect scheduling itself
// (the actual schedule lives in your external cron config).
const EXPECTED_INTERVAL_MINUTES = {
  'release-stale-accounts': 15,
  'reactivate-expired-accounts': 15,
  'auto-provision-pool': 60,
  'run-settlement': 60 * 24,
  'generate-invoices': 60 * 24,
  'fetch-and-reconcile': 60 * 24,
  'reconcile-outbound': 15,
  // Not cron-triggered like the others (it's a continuously-running
  // poll loop, not an HTTP route) - but it heartbeats itself every 60s
  // (see outboxWorker.js), so a stalled/crashed outbox worker still
  // shows up here instead of only being noticed once payments start
  // silently failing to notify merchants.
  'outbox-worker': 2,
};
const { ensureDefaultBankPartners, provisionAccountPool, maintainAccountPools } = require('../bankPartner/bankPartner.service');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const BankPartner = require('../bankPartner/bankPartner.model');
const Merchant = require('../merchant/merchant.model');
const limits = require('../../config/limits');
const { releaseStaleAssignedAccounts, reactivateExpiredAccounts } = require('../virtualAccount/virtualAccount.service');
const { SUPPORTED_CURRENCIES } = require('../../config/currencies');
const { runSettlementCycle } = require('../settlement/settlement.service');
const { generateDueInvoices, markOverdueInvoices } = require('../subscription/subscription.service');
const { withCronLock } = require('../../utils/cronLock');

// ================= NAMED ADMIN SESSIONS =================
// See adminUser.model.js for why this exists alongside the shared
// INFRA_ADMIN_KEY. Login itself only needs the key (proves "someone with
// ops access is trying to log an admin in"), not a role - role gating
// happens per-route below via requireAdminRole().
router.post('/auth/login', requireAdminKey, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { token, admin } = await loginAdmin({ email, password });
    res.json({ status: true, data: { token, admin } });
  } catch (err) {
    res.status(401).json({ status: false, message: err.message });
  }
});

// ================= STUCK PAYMENT VISIBILITY & MANUAL RESOLUTION =================
// Companion to scripts/reconcile-outbound.js. That script auto-resolves
// anything the bank can confirm one way or the other. These routes cover
// the rest: (1) seeing what's stuck at all, and (2) a human manually
// deciding an outcome for the rare case where even the bank's status
// check comes back inconclusive (e.g. RexxPay Bank support confirms the
// outcome over a phone call/support ticket, not through the API).
const Payout = require('../payout/payout.model');
const Withdrawal = require('../withdrawal/withdrawal.model');
const Refund = require('../refund/refund.model');
const { confirmPayoutOutcome } = require('../payout/payout.service');
const { confirmWithdrawalOutcome } = require('../withdrawal/withdrawal.service');
const { confirmRefundOutcome } = require('../refund/refund.service');

// Visit:
//   /api/admin/stuck-payments?adminKey=YOUR_KEY
router.get('/stuck-payments', requireAdminKey, async (req, res) => {
  try {
    const [payouts, withdrawals, refunds] = await Promise.all([
      Payout.find({ mode: 'live', status: { $in: ['processing', 'ambiguous'] } }).sort({ updatedAt: 1 }),
      Withdrawal.find({ mode: 'live', status: { $in: ['processing', 'ambiguous'] } }).sort({ updatedAt: 1 }),
      Refund.find({ mode: 'live', status: { $in: ['pending', 'submitted'] } }).sort({ updatedAt: 1 }),
    ]);

    res.json({
      status: true,
      data: {
        payouts,
        withdrawals,
        refunds,
        totalStuck: payouts.length + withdrawals.length + refunds.length,
      },
    });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// Read-only ops browsing (req. #24: "dashboard/API for ... webhook events,
// failed jobs, dead-letter events ... audit logs ... merchants"). These
// were previously the biggest gap in admin tooling - every action endpoint
// below (resolve, verify, fees) existed, but there was no way to browse
// the underlying data at all short of connecting to Mongo directly.

// GET /api/admin/webhook-events?status=failed&limit=50
// status=failed with attempts>=5 is effectively the dead-letter queue -
// see MAX_ATTEMPTS in webhook.processor.js.
router.get('/webhook-events', requireAdminKey, async (req, res) => {
  try {
    const { status, source, limit } = req.query;
    const query = {};
    if (status) query.status = status;
    if (source) query.source = source;

    const events = await WebhookEvent.find(query)
      .sort({ updatedAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200));

    res.json({ status: true, data: events });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /api/admin/webhook-events/:id/redrive
// Manual redrive for a permanently-failed (dead-lettered) event - see
// webhook.processor.js#redriveFailedEvent. Distinct from the automatic
// redriveStuckEvents() that already runs for events crashed mid-processing.
router.post('/webhook-events/:id/redrive', requireAdminKey, requireAdminRole('finance', 'superadmin'), async (req, res) => {
  try {
    const event = await redriveFailedEvent(req.params.id);

    await auditLog.record({
      actorType: 'admin',
      actorRef: req.adminUser.id,
      action: 'admin.webhook_event_redriven',
      entityType: 'WebhookEvent',
      entityRef: event._id.toString(),
      severity: 'warning',
    });

    res.json({ status: true, message: 'Event requeued.', data: event });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

// GET /api/admin/audit-logs?actorType=&action=&severity=&limit=
router.get('/audit-logs', requireAdminKey, async (req, res) => {
  try {
    const { actorType, action, entityType, entityRef, severity, limit, before } = req.query;
    const logs = await listAuditLogs({ actorType, action, entityType, entityRef, severity, limit, before });
    res.json({ status: true, data: logs });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// GET /api/admin/merchants?limit=&isVerified=
// Deliberately excludes secret-key hashes and passwordHash - same
// exclusion merchant.service.js#getProfile already applies to a
// merchant's own view of themselves.
router.get('/merchants', requireAdminKey, async (req, res) => {
  try {
    const { isVerified, limit } = req.query;
    const query = {};
    if (isVerified !== undefined) query.isVerified = isVerified === 'true';

    const merchants = await Merchant.find(query)
      .select('-passwordHash -testSecretKeyHash -liveSecretKeyHash -webhookSecret')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200));

    res.json({ status: true, data: merchants });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// Manually decide the outcome of a specific stuck payout/withdrawal/refund,
// after confirming the real answer with RexxPay Bank outside of the API
// (support call, dashboard, email). This calls the exact same
// confirm*Outcome() function the real webhook would call - it is not a
// separate, less-safe path for moving money, it's the same one with a
// human supplying the trigger instead of a webhook.
//
//   POST /api/admin/payouts/:reference/resolve?adminKey=YOUR_KEY
//   { "success": true, "providerRef": "rxp_abc123" }
//   { "success": false, "failureReason": "confirmed_declined_by_bank_support" }
router.post('/payouts/:reference/resolve', requireAdminKey, requireAdminRole('finance', 'superadmin'), async (req, res) => {
  try {
    const { success, providerRef, failureReason } = req.body || {};
    if (typeof success !== 'boolean') return res.status(400).json({ status: false, message: 'success_boolean_required' });
    const payout = await confirmPayoutOutcome({ reference: req.params.reference, success, providerRef, failureReason });
    await auditLog.record({
      actorType: 'admin',
      actorRef: req.adminUser.id,
      action: 'admin.payout_resolved',
      entityType: 'Payout',
      entityRef: payout._id.toString(),
      severity: 'warning',
      metadata: { reference: req.params.reference, success, providerRef },
    });
    res.json({ status: true, data: payout });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

router.post('/withdrawals/:reference/resolve', requireAdminKey, requireAdminRole('finance', 'superadmin'), async (req, res) => {
  try {
    const { success, providerRef, failureReason } = req.body || {};
    if (typeof success !== 'boolean') return res.status(400).json({ status: false, message: 'success_boolean_required' });
    const withdrawal = await confirmWithdrawalOutcome({ reference: req.params.reference, success, providerRef, failureReason });
    await auditLog.record({
      actorType: 'admin',
      actorRef: req.adminUser.id,
      action: 'admin.withdrawal_resolved',
      entityType: 'Withdrawal',
      entityRef: withdrawal._id.toString(),
      severity: 'warning',
      metadata: { reference: req.params.reference, success, providerRef },
    });
    res.json({ status: true, data: withdrawal });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

router.post('/refunds/:reference/resolve', requireAdminKey, requireAdminRole('finance', 'superadmin'), async (req, res) => {
  try {
    const { success, providerRef, failureReason } = req.body || {};
    if (typeof success !== 'boolean') return res.status(400).json({ status: false, message: 'success_boolean_required' });
    const refund = await confirmRefundOutcome({ reference: req.params.reference, success, providerRef, failureReason });
    await auditLog.record({
      actorType: 'admin',
      actorRef: req.adminUser.id,
      action: 'admin.refund_resolved',
      entityType: 'Refund',
      entityRef: refund._id.toString(),
      severity: 'warning',
      metadata: { reference: req.params.reference, success, providerRef },
    });
    res.json({ status: true, data: refund });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});


// Manually resolve an inbound transaction that was flagged by
// amount limits, velocity limits, or sanctions screening.
//
// RELEASE:
//   POST /api/admin/transactions/:reference/resolve?adminKey=YOUR_KEY
//   Authorization: Bearer <admin session token from /auth/login>
//   { "action": "release" }
//
// REJECT:
//   POST /api/admin/transactions/:reference/resolve?adminKey=YOUR_KEY
//   Authorization: Bearer <admin session token from /auth/login>
//   { "action": "reject" }
//
// Release performs the same wallet + ledger accounting required for
// a legitimate inbound payment. Reject changes the transaction to
// failed without crediting the merchant.
router.post('/transactions/:reference/resolve', requireAdminKey, requireAdminRole('finance', 'superadmin'), async (req, res) => {
  try {
    const { action } = req.body || {};

    if (!['release', 'reject'].includes(action)) {
      return res.status(400).json({
        status: false,
        message: 'action_must_be_release_or_reject',
      });
    }

    const transaction = await resolveFlaggedTransaction({
      reference: req.params.reference,
      action,
    });

    await auditLog.record({
      actorType: 'admin',
      actorRef: req.adminUser.id,
      action: `admin.flagged_transaction_${action}d`,
      entityType: 'Transaction',
      entityRef: transaction._id.toString(),
      severity: 'warning',
      metadata: { reference: req.params.reference, action },
    });

    res.json({
      status: true,
      data: transaction,
    });
  } catch (err) {
    res.status(400).json({
      status: false,
      message: err.message,
    });
  }
});

// GET so it's genuinely "visit a URL" - no curl/Postman needed. A GET that
// changes state is unconventional REST, but this is an internal operator
// tool behind a secret key, not a public API - convenience wins here.
//
// Visit:
//   https://checkout-rexxpay.onrender.com/api/admin/provision-pool?bankSlug=rexxpay-bank&count=100&adminKey=YOUR_KEY
//
// Prefer sending the key as a header (x-admin-key) over a browser URL bar
// when you can - URLs get logged in browser history and server access
// logs. The query param exists purely for "paste a link and go" convenience.
router.get('/provision-pool', requireAdminKey, async (req, res) => {
  try {
    const bankSlug = req.query.bankSlug || 'rexxpay-bank';
    const count = Math.min(parseInt(req.query.count, 10) || 20, 500); // hard cap per call

    // Only the live pool can be provisioned here - test-mode accounts
    // are minted on demand per checkout and are never pre-provisioned
    // (see provisionAccountPool in bankPartner.service.js).
    await ensureDefaultBankPartners();
    await provisionAccountPool(bankSlug, count, 'live');

    const available = await VirtualAccount.countDocuments({ status: 'available' });
    const assigned = await VirtualAccount.countDocuments({ status: 'assigned' });

    res.json({
      status: true,
      message: `Provisioned ${count} account(s) from ${bankSlug}.`,
      poolTotals: { available, assigned },
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

// Quick pool health check - visit this any time to see if you're running low.
//   https://checkout-rexxpay.onrender.com/api/admin/pool-status?adminKey=YOUR_KEY
router.get('/pool-status', requireAdminKey, async (req, res) => {
  try {
    const banks = await BankPartner.find();
    const byBank = await Promise.all(
      banks.map(async (bank) => ({
        bank: bank.slug,
        live: {
          available: await VirtualAccount.countDocuments({ bank: bank._id, status: 'available', mode: 'live' }),
          assigned: await VirtualAccount.countDocuments({ bank: bank._id, status: 'assigned', mode: 'live' }),
        },
        test: {
          available: await VirtualAccount.countDocuments({ bank: bank._id, status: 'available', mode: 'test' }),
          assigned: await VirtualAccount.countDocuments({ bank: bank._id, status: 'assigned', mode: 'test' }),
        },
      }))
    );
    res.json({ status: true, data: byBank });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// Set (or clear) a per-merchant platform fee override. Any field left out
// of the body clears back to the global default (src/config/fees.js).
// Never merchant-settable - deliberately admin-key-only.
//
//   PATCH /api/admin/merchants/:id/fees
//   { "percentageBps": 100, "fixedMinor": 5000, "capMinor": 150000 }
router.patch('/merchants/:id/settlement-account/verify', requireAdminKey, async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.params.id);
    if (!merchant) return res.status(404).json({ status: false, message: 'merchant_not_found' });
    if (!merchant.settlementAccount?.bankCode || !merchant.settlementAccount?.accountNumber || !merchant.settlementAccount?.accountName) return res.status(400).json({ status: false, message: 'settlement_account_required' });
    merchant.settlementAccount.verified = true;
    merchant.settlementAccount.verifiedAt = new Date();
    await merchant.save();
    res.json({ status: true, message: 'Settlement account verified.', data: merchant });
  } catch (err) { res.status(400).json({ status: false, message: err.message }); }
});

// Manual fallback for verifying a payout Recipient's account name when
// automated provider resolution (bankPartner.service.js#resolveBankAccount)
// wasn't available at recipient-creation time - see
// recipient.service.js#createRecipient. Requires a named finance/
// superadmin session (not just the shared INFRA_ADMIN_KEY), same as the
// other money-moving admin actions, since this flips a control that
// gates real outbound transfers.
//
//   PATCH /api/admin/recipients/:id/verify
router.patch('/recipients/:id/verify', requireAdminKey, requireAdminRole('finance', 'superadmin'), async (req, res) => {
  try {
    const Recipient = require('../recipient/recipient.model');
    const recipient = await Recipient.findById(req.params.id);
    if (!recipient) return res.status(404).json({ status: false, message: 'recipient_not_found' });

    recipient.verified = true;
    recipient.verifiedAt = new Date();
    recipient.verificationMethod = 'admin';
    await recipient.save();

    await auditLog.record({
      actorType: 'admin',
      actorRef: req.adminUser.id,
      action: 'admin.recipient_verified',
      entityType: 'Recipient',
      entityRef: recipient._id.toString(),
      severity: 'info',
      metadata: { recipientCode: recipient.recipientCode },
    });

    res.json({ status: true, message: 'Recipient verified.', data: recipient });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

router.patch('/merchants/:id/fees', requireAdminKey, async (req, res) => {
  try {
    const { percentageBps, fixedMinor, capMinor } = req.body;
    const fees = {};
    if (percentageBps != null) fees.percentageBps = Number(percentageBps);
    if (fixedMinor != null) fees.fixedMinor = Number(fixedMinor);
    if (capMinor != null) fees.capMinor = Number(capMinor);

    const merchant = await Merchant.findByIdAndUpdate(
      req.params.id,
      { $set: { fees } },
      { new: true }
    ).select('businessName fees');

    if (!merchant) {
      return res.status(404).json({ status: false, message: 'merchant_not_found' });
    }

    res.json({ status: true, data: merchant });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

// ================= CRON TRIGGER ENDPOINTS =================
// Same idea as /provision-pool above: these mirror the equivalent
// scripts/*.js file exactly (same service functions, same logic) so an
// external scheduler (Hostinger cron, cron-job.org, GitHub Actions, etc.)
// can trigger them with a plain GET request instead of needing shell/SSH
// access to run `node scripts/*.js` directly. Guarded by the same
// requireAdminKey middleware as every other admin route.
//
// Visit (or curl, or point a cron job at):
//   https://checkout-rexxpay.onrender.com/api/admin/cron/release-stale-accounts?cronKey=YOUR_CRON_KEY
//   https://checkout-rexxpay.onrender.com/api/admin/cron/reactivate-expired-accounts?cronKey=YOUR_CRON_KEY
//   https://checkout-rexxpay.onrender.com/api/admin/cron/auto-provision-pool?cronKey=YOUR_CRON_KEY
//   https://checkout-rexxpay.onrender.com/api/admin/cron/run-settlement?cronKey=YOUR_CRON_KEY
//   https://checkout-rexxpay.onrender.com/api/admin/cron/generate-invoices?cronKey=YOUR_CRON_KEY
//
// CRON_TRIGGER_KEY is a separate secret from INFRA_ADMIN_KEY - set both
// in .env, rotate them independently.

// Mirrors scripts/release-stale-accounts.js
router.get('/cron/release-stale-accounts', requireCronKey, async (req, res) => {
  try {
    // Locked so two overlapping invocations can't both grab the same
    // stale-assigned account and race releasing it - releaseStaleAssignedAccounts()
    // is itself idempotent per-account, but the lock avoids doing the
    // work twice and two heartbeats/log lines for one logical run.
    const { skipped, result: released } = await withCronLock('release-stale-accounts', () =>
      releaseStaleAssignedAccounts(limits.VIRTUAL_ACCOUNT_EXPIRY_MINUTES)
    );

    if (skipped) {
      await recordHeartbeat('release-stale-accounts', true, 'skipped - another run already in progress');
      return res.status(200).json({ status: true, skipped: true, message: 'another release-stale-accounts run is already in progress' });
    }

    await recordHeartbeat('release-stale-accounts', true);
    res.json({
      status: true,
      message: `Released ${released} account(s) assigned longer than ${limits.VIRTUAL_ACCOUNT_EXPIRY_MINUTES} minute(s) with no payment.`,
      released,
    });
  } catch (err) {
    await recordHeartbeat('release-stale-accounts', false, err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// Mirrors scripts/reactivate-expired-accounts.js
router.get('/cron/reactivate-expired-accounts', requireCronKey, async (req, res) => {
  try {
    const { skipped, result: reactivated } = await withCronLock('reactivate-expired-accounts', () =>
      reactivateExpiredAccounts()
    );

    if (skipped) {
      await recordHeartbeat('reactivate-expired-accounts', true, 'skipped - another run already in progress');
      return res.status(200).json({ status: true, skipped: true, message: 'another reactivate-expired-accounts run is already in progress' });
    }

    await recordHeartbeat('reactivate-expired-accounts', true);
    res.json({
      status: true,
      message: `Reactivated ${reactivated} account(s) whose cooldown expired.`,
      reactivated,
    });
  } catch (err) {
    await recordHeartbeat('reactivate-expired-accounts', false, err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// Mirrors scripts/auto-provision-pool.js
router.get('/cron/auto-provision-pool', requireCronKey, async (req, res) => {
  try {
    const threshold = req.query.threshold ? parseInt(req.query.threshold, 10) : limits.POOL_MIN_THRESHOLD;
    const topUpCount = req.query.topUpCount ? parseInt(req.query.topUpCount, 10) : limits.POOL_TOPUP_COUNT;

    await ensureDefaultBankPartners();

    // Prevents two overlapping invocations (a slow run overlapping the
    // next scheduled trigger, two instances both hit this endpoint) from
    // both seeing the pool below threshold and both topping it up (see
    // audit report, Medium #27).
    const { skipped, result: results } = await withCronLock('pool-provisioning', () =>
      maintainAccountPools({ threshold, topUpCount })
    );

    if (skipped) {
      await recordHeartbeat('auto-provision-pool', true, 'skipped - another run already in progress');
      return res.status(200).json({ status: true, skipped: true, message: 'another auto-provision-pool run is already in progress' });
    }

    const anyFailed = results.some((r) => r.action === 'failed');

    await recordHeartbeat('auto-provision-pool', !anyFailed, anyFailed ? 'one or more pool top-ups failed' : null);
    res.status(anyFailed ? 207 : 200).json({ status: !anyFailed, results });
  } catch (err) {
    await recordHeartbeat('auto-provision-pool', false, err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// Mirrors scripts/run-settlement.js
router.get('/cron/run-settlement', requireCronKey, async (req, res) => {
  try {
    const requested = req.query.currencies
      ? String(req.query.currencies).split(',').map((c) => c.trim().toUpperCase())
      : Object.keys(SUPPORTED_CURRENCIES);

    // Locked so two overlapping runs can't both move the same batch of
    // eligible transactions through pending_settlement -> settled ->
    // available and each write a SettlementBatch for it.
    const { skipped, result: summary } = await withCronLock('run-settlement', async () => {
      const results = [];
      for (const currency of requested) {
        for (const mode of ['live', 'test']) {
          try {
            const { settleBatch, availableBatch } = await runSettlementCycle({ currency, mode });
            results.push({
              currency,
              mode,
              settled: { count: settleBatch.transactionCount, amount: settleBatch.totalAmount, status: settleBatch.status },
              madeAvailable: { count: availableBatch.transactionCount, amount: availableBatch.totalAmount, status: availableBatch.status },
            });
          } catch (err) {
            results.push({ currency, mode, error: err.message });
          }
        }
      }
      return results;
    });

    if (skipped) {
      await recordHeartbeat('run-settlement', true, 'skipped - another run already in progress');
      return res.status(200).json({ status: true, skipped: true, message: 'another run-settlement run is already in progress' });
    }

    const anyFailed = summary.some(
      (s) => s.error || s.settled?.status === 'failed' || s.madeAvailable?.status === 'failed'
    );

    await recordHeartbeat('run-settlement', !anyFailed, anyFailed ? 'one or more currencies failed to settle' : null);
    res.status(anyFailed ? 207 : 200).json({ status: !anyFailed, summary });
  } catch (err) {
    await recordHeartbeat('run-settlement', false, err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// Mirrors scripts/generate-invoices.js
router.get('/cron/generate-invoices', requireCronKey, async (req, res) => {
  try {
    // Locked so two overlapping runs can't both see the same due
    // subscription and each create a separate Invoice + virtual account
    // for the same billing period.
    const { skipped, result } = await withCronLock('generate-invoices', async () => {
      const invoices = await generateDueInvoices();
      const overdueCount = await markOverdueInvoices();
      return { invoices, overdueCount };
    });

    if (skipped) {
      await recordHeartbeat('generate-invoices', true, 'skipped - another run already in progress');
      return res.status(200).json({ status: true, skipped: true, message: 'another generate-invoices run is already in progress' });
    }

    await recordHeartbeat('generate-invoices', true);
    res.json({
      status: true,
      message: `Generated/confirmed ${result.invoices.length} invoice(s); marked ${result.overdueCount} as overdue.`,
      generated: result.invoices.length,
      overdue: result.overdueCount,
    });
  } catch (err) {
    await recordHeartbeat('generate-invoices', false, err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});



// Mirrors scripts/fetch-and-reconcile.js - now called directly, in-process
// (reusing this app's own already-open database connection), instead of
// spawning a separate `node` child process from inside this HTTP handler.
router.get('/cron/fetch-and-reconcile', requireCronKey, async (req, res) => {
  try {
    const { fetchAndReconcile } = require('../../../scripts/fetch-and-reconcile');
    const { hasDiscrepancies } = require('../../../scripts/reconcile');

    // Locked so two overlapping runs can't both pull and report on the
    // same bank export window, which would otherwise show up as two
    // separate (and confusingly identical-looking) discrepancy reports.
    const { skipped, result } = await withCronLock('fetch-and-reconcile', () =>
      fetchAndReconcile({ from: req.query.from, to: req.query.to })
    );

    if (skipped) {
      await recordHeartbeat('fetch-and-reconcile', true, 'skipped - another run already in progress');
      return res.status(200).json({ status: true, skipped: true, message: 'another fetch-and-reconcile run is already in progress' });
    }

    const { from, to, rowsFetched, report } = result;
    const discrepant = hasDiscrepancies(report);

    // Same meaning as before: discrepancies found is a meaningful result
    // to report, not a crash - 207 (multi-status) rather than 500.
    await recordHeartbeat('fetch-and-reconcile', !discrepant, discrepant ? 'discrepancies found - see report' : null);
    res.status(discrepant ? 207 : 200).json({
      status: !discrepant,
      from,
      to,
      rowsFetched,
      report,
    });
  } catch (err) {
    await recordHeartbeat('fetch-and-reconcile', false, err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});
// Mirrors scripts/reconcile-outbound.js - now called directly, in-process
// (reusing this app's own already-open database connection). Without this
// route, a payout/withdrawal/refund left 'processing'/'ambiguous'/'reserved'
// by a missed bank webhook only gets resolved if a human remembers to run
// the script by hand (see audit report, High #20).
router.get('/cron/reconcile-outbound', requireCronKey, async (req, res) => {
  try {
    const { runOutboundReconciliation } = require('../../../scripts/reconcile-outbound');

    const stuckAfterMinutes = req.query.minutes ? Number(req.query.minutes) : undefined;

    // Locked so two overlapping runs can't both "claim" the same stuck
    // payout/withdrawal/refund and both act on the bank's response to it.
    const { skipped, result } = await withCronLock('reconcile-outbound', () =>
      runOutboundReconciliation({ stuckAfterMinutes })
    );

    if (skipped) {
      await recordHeartbeat('reconcile-outbound', true, 'skipped - another run already in progress');
      return res.status(200).json({ status: true, skipped: true, message: 'another reconcile-outbound run is already in progress' });
    }

    const { report, stillUnresolved } = result;

    await recordHeartbeat(
      'reconcile-outbound',
      stillUnresolved === 0,
      stillUnresolved > 0 ? `${stillUnresolved} record(s) still stuck after checking with the bank` : null
    );

    // Same meaning as the CLI script's exit code: records still stuck
    // after actively checking with the bank is a meaningful result to
    // report, not a crash - 207 (multi-status) rather than 500.
    res.status(stillUnresolved > 0 ? 207 : 200).json({
      status: stillUnresolved === 0,
      stillUnresolved,
      report,
    });
  } catch (err) {
    await recordHeartbeat('reconcile-outbound', false, err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// GET /api/admin/cron/health
// Answers "has anything that's supposed to run on a schedule stopped
// firing?" - checks each job's last heartbeat against how often it's
// expected to run. Admin-key protected (not cron-key) since this is
// for you to check, not something the scheduler itself calls.
router.get('/cron/health', requireAdminKey, async (req, res) => {
  const heartbeats = await CronHeartbeat.find({});
  const byName = Object.fromEntries(heartbeats.map((h) => [h.jobName, h]));

  const jobs = Object.entries(EXPECTED_INTERVAL_MINUTES).map(([jobName, expectedMinutes]) => {
    const hb = byName[jobName];
    const staleAfter = expectedMinutes * 2 * 60 * 1000; // 2x grace window
    const stale = !hb || (Date.now() - new Date(hb.lastRunAt).getTime()) > staleAfter;

    return {
      jobName,
      lastRunAt: hb?.lastRunAt || null,
      lastStatus: hb?.lastStatus || 'never_run',
      lastError: hb?.lastError || null,
      expectedIntervalMinutes: expectedMinutes,
      stale,
    };
  });

  const anyStale = jobs.some((j) => j.stale);

  res.status(anyStale ? 207 : 200).json({ status: !anyStale, jobs });
});


module.exports = router;
