// src/middleware/rateLimit.middleware.js
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('./redisRateLimitStore');

// General API traffic — generous, just to blunt abuse/scraping.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'general', windowMs: 15 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_requests',
  },
});

// Auth endpoints (login/register/etc) — tight, since this is the
// classic brute-force / credential-stuffing target.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'auth', windowMs: 15 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_auth_attempts',
  },
});

// Webhook receivers — bank/provider callbacks are usually low volume
// per source, but this endpoint is public and unauthenticated up until
// signature verification runs, so cap it well above legitimate traffic
// to absorb flood/replay abuse without needing to trust the caller first.
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'webhook', windowMs: 1 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_webhook_requests',
  },
});

// Public demo checkout — unauthenticated by design (see demo.routes.js),
// so this is the only thing standing between it and abuse (someone
// scripting thousands of fake checkouts against the demo merchant).
// Tighter than generalLimiter, looser than authLimiter — a real visitor
// clicking through the demo a few times should never hit this.
const demoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'demo', windowMs: 15 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_demo_requests',
  },
});

// Money-OUT endpoints — payouts, withdrawals, refunds. These are the
// highest-value target for automated abuse (credential-stuffed API keys,
// a compromised integration hammering the endpoint) and previously had
// no limiter of their own, just the shared 300/15min generalLimiter that
// every other route (GET /transactions, dashboard polling, etc.) also
// draws from. A merchant's own dashboard polling could exhaust the same
// budget an attacker would need to be slowed down by.
const moneyMovementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'money-out', windowMs: 15 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_transfer_requests',
  },
});

// Payment initialization/verification — not money-out, but still worth
// separating from generalLimiter so a burst of checkout traffic from one
// merchant can't crowd out another merchant's dashboard/API calls, and so
// verify (often polled tightly by pay.html) doesn't share a budget with
// initialize.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'payment', windowMs: 15 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_payment_requests',
  },
});

// Bank-account resolution — this proxies out to the bank partner's own
// API per call (see bankPartner.service.js), so an unbounded client here
// is effectively an unbounded amplification vector against RexxPay
// Bank's rate limits, not just ours.
const accountResolutionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'acct-resolve', windowMs: 15 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_account_resolution_requests',
  },
});

// Admin/operator routes (/api/admin/*). Low legitimate volume (a human
// or a cron job, not a merchant integration), guards a shared secret
// (INFRA_ADMIN_KEY) that generalLimiter's 300/15min never meaningfully
// protected against brute-forcing.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'admin', windowMs: 15 * 60 * 1000 }),
  message: {
    status: false,
    message: 'too_many_admin_requests',
  },
});

module.exports = {
  generalLimiter,
  authLimiter,
  webhookLimiter,
  demoLimiter,
  moneyMovementLimiter,
  paymentLimiter,
  accountResolutionLimiter,
  adminLimiter,
};
