# SwiftPay

A Paystack-style payment infrastructure: merchants integrate, onboard customers,
get assigned dedicated virtual accounts, and receive verified webhook-driven
wallet credits when customers pay via bank transfer.

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose
- JWT (merchant dashboard auth) + API key auth (merchant integration auth)
- HMAC-signed webhooks

## Architecture

```
Merchant  --(secret key)-->  SwiftPay API  --(pool assignment)-->  Bank Partner
                                   ^                                     |
                                   |                                     v
                          verified webhook  <----------------  customer transfers money
                                   |
                                   v
                        Transaction recorded + Wallet credited
```

The "Bank Partner" above is one of two things depending on environment:

- **Mock bank partner** (`bankPartner` module + a test-mode checkout's
  `POST /checkout/:token/simulate`, dev-only) — generates fake pool accounts
  locally and fires a self-signed webhook, so the full loop can be tested
  without any external dependency.
- **RexxPay Bank** (real) — `bankPartner.service.js` can also provision real
  pool accounts from an external RexxPay Bank instance over HTTP, authenticated
  with `REXXPAY_BANK_ADMIN_KEY` against `REXXPAY_BANK_BASE_URL`. This is the
  non-mock path and is what a production deployment would use.

### Modules

| Module | Responsibility |
|---|---|
| `auth` | Merchant registration/login, JWT dashboard sessions, API key issuance |
| `merchant` | Merchant profile, webhook URL configuration |
| `customer` | Merchant's end-customers |
| `bankPartner` | Bank partner records; provisions pooled account numbers (mock locally, or real via RexxPay Bank) |
| `virtualAccount` | Assigns pooled accounts to customers (never mints new ones) |
| `payment` | Hosted checkout: creates the customer, assigns a virtual account, and returns a payment link (`pay.html`) a merchant can redirect to; `verify` polls the resulting transaction status |
| `checkout` | Public, no-API-key endpoints the customer's browser calls directly — `GET /checkout/:token/status`, `POST /checkout/:token/simulate` (test-mode only), `GET /checkout/:token/complete` |
| `mockBank` | Local, dev-only stand-in for a real bank partner — generates fake pool accounts and fires a self-signed webhook so the full loop is testable with no external dependency |
| `wallet` | Merchant settlement balance, atomic credit/debit |
| `transaction` | Ledger of every payment event, idempotent recording |
| `payout` | Outbound transfers to merchants' real bank accounts |
| `webhook` | Verifies bank partner signatures; the ONLY path that can mark a payment successful |
| `admin` | Operator-only endpoints (behind `INFRA_ADMIN_KEY`) to provision the account pool and check pool health |
| `demo` | Backs the public `/demo` page — a no-signup, test-mode-only checkout run against one dedicated, auto-provisioned demo merchant, so a visitor can try the flow without ever touching a real merchant's data |

### Key design decisions (and why)

- **Accounts are pooled, not generated on demand.** A `VirtualAccount` pool is
  pre-provisioned per bank partner. Assignment just links an `available`
  account to a customer — matching how Paystack's real dedicated virtual
  accounts work.
- **Only the signed webhook can mark a transaction successful.** No public
  endpoint lets a client or merchant directly set a transaction to
  `success` — that would let anyone credit their own wallet for free.
- **Idempotency everywhere.** Webhook processing keys off the bank's own
  transaction reference so retried/duplicate webhooks don't double-credit.
- **Wallet updates are atomic (`$inc`)**, not read-then-write, to avoid race
  conditions when multiple webhooks land close together.

## What's been added beyond the original mock

This started as an architecturally-correct mock of a Paystack-style
processor. The pieces below move it closer to how a real payment company
is actually built — but read the "Still not real" section too, since some
of this is a real control and some is a stub showing where a real control
must go.

| Module | What it does |
|---|---|
| `ledger` | Double-entry bookkeeping (`LedgerEntry`). Every wallet credit/debit also posts a balanced debit+credit pair, tagged by `currency` AND `mode` (test/live are never allowed to net into the same balance — see `computeBalance()`/`computeBalancesByCurrencyAndMode()`). `wallet.balance` is now a cache; the ledger is the source of truth and can rebuild any balance from history. |
| `audit` | Append-only `AuditLog` — every webhook signature failure, flagged transaction, payout, and login writes a record. `metadata` is redacted for known-sensitive field names (account numbers, secrets, tokens) before it's ever written, regardless of which call site supplied it. |
| `webhook` (reworked) | The HTTP handler now only verifies the signature, persists the raw event (`WebhookEvent`), and acks. Actual processing happens async via a durable, Redis-backed BullMQ queue (`src/queue/webhookQueue.js` + `webhookWorker.js`), with retry/backoff owned by BullMQ and a `redriveStuckEvents()` call on startup that re-enqueues anything left mid-flight after a crash. Post-payment side effects are no longer handled inline at all — see `outbox` below. |
| `outbox` | A real transactional outbox (`OutboxEvent`, `src/modules/outbox/`). `recordIncomingPayment()` enqueues "deactivate the virtual account", "notify the merchant", and "reconcile the invoice" as `OutboxEvent` documents **inside the same DB transaction** as the financial commit — so if the transaction commits, the outbox events exist, atomically, guaranteed by MongoDB itself, regardless of whether the process crashes immediately after. A separate, independent process (`src/queue/outboxWorker.js`) polls for and dispatches them, with its own exponential-backoff retry and stuck-`processing` recovery. This closed the last real gap from the "crash between money-recorded and merchant-notified" class of bug — see "Known gaps" below for what a fuller outbox implementation would still add. |
| `payout` | The outbound half of the system — merchants can request a payout to a real bank account. Debits the wallet, posts ledger entries, and calls `rexxPayBankClient.sendPayoutInstruction()`, which makes a real signed HTTP call to the RexxPay Bank instance (retries with backoff, and flags ambiguous outcomes so a network failure isn't silently treated as success or failure). Test-mode payouts instead hit `simulatePayoutInstruction()`, which makes no network call at all. `idempotencyKey` is required in live mode and bound to a hash of the request's actual parameters — reusing a key with a different amount/destination is rejected rather than silently returning the original payout. |
| `payment` | Hosted checkout on top of the existing virtual-account primitive — `initialize` creates the customer + account and hands back a link; `verify` reads back the transaction status by `tx_ref`. `tx_ref` is a real idempotency key: the same `(merchant, mode, tx_ref)` always maps back to the same checkout, enforced by a unique DB index, not just an application-level check. |
| `admin` | HTTP-based operator tooling (`provision-pool`, `pool-status`, stuck-payment visibility/resolution, flagged-transaction release/reject) guarded by `INFRA_ADMIN_KEY`. Money-moving actions additionally require a named admin session (`POST /admin/auth/login`, role `finance`/`superadmin`) — see `adminUser.model.js` — so those specific actions are tied to an accountable person, not just "whoever has the shared key". |
| `config/limits.js` + risk checks in `transaction.service.js` | Per-transaction, daily, and velocity limits. Transactions that exceed them land as `status: 'flagged'` instead of auto-crediting, for manual review, and can be released or rejected via `POST /api/admin/transactions/:reference/resolve`. |
| `utils/sanctionsCheck.js` | **Stub only** — shows where real AML/sanctions screening (OFAC/UN/NFIU lists via a licensed provider) must run, with a dev-only denylist for testing the flagging path. |
| `scripts/reconcile.js` | Compares our transaction records against a bank settlement export (JSON), scoped to the same date range as the export, and reports mismatches in both directions — money we think we have that the bank doesn't confirm, and money the bank settled that we never recorded. `scripts/fetch-and-reconcile.js` automates pulling that export and runs this on a schedule; `scripts/reconcile-outbound.js` does the same for outbound payouts/withdrawals/refunds stuck `reserved`/`processing`/`ambiguous`. |
| Idempotency | `Transaction.reference`, `Payout.reference`, and `Checkout`'s `(merchant, mode, txRef)` all have unique DB indexes, so even a race between two concurrent requests fails safely at the database level, not just in application logic. Payout/withdrawal/refund idempotency keys are additionally bound to a fingerprint of the request's own parameters (see `utils/requestFingerprint.js`), so reusing a key for a materially different request is rejected instead of silently returning the original operation. |
| `settlement` | Moves a successful transaction through `pending_settlement → settled → available` on a schedule (`scripts/run-settlement.js`), recording one `SettlementBatch` per cycle per phase so any transaction's settlement history is traceable, not just an invisible cron side effect. |
| `refund` | Full or partial refunds against a settled transaction; posts the reversing ledger entries and drives its own `pending → processing → successful/failed/reversed` status. |
| `subaccount` | Paystack-style split payments — routes a percentage of an incoming payment to a sub-merchant's ledger balance (no login/wallet of its own) at checkout time, and lets the parent merchant settle that balance out to the subaccount's bank account on demand. Settlement is per `(currency, mode)` bucket (never pools test/live or mismatched currencies into one payout) and is concurrency-safe — two simultaneous settlement requests can't drain the same balance twice, enforced via a write-conflict lock on the subaccount document inside the settlement transaction, not just an application-level check. |
| `recipient` | Saved payout destinations (`rcp_xxxxx`) a merchant can reuse across `payout`/`payout/bulk` calls instead of re-typing bank details each time. |
| `subscription` | Recurring billing: merchants define `Plan`s, customers `Subscription` to them, and `scripts/generate-invoices.js` sweeps due subscriptions to create `Invoice`s (each with its own pay-in virtual account) on a schedule. |
| `dispute` | Chargeback handling — ops opens a dispute against a transaction (freezing the disputed amount), the merchant submits evidence within `DISPUTE_EVIDENCE_WINDOW_DAYS`, and ops resolves it `won`/`lost`. |

## Still not real (and why it's hard)

- **`sanctionsCheck.js`** is exact-string-match against an env var — real
  screening needs fuzzy name matching against maintained watchlists via a
  licensed provider.
- **No license.** None of the above makes this legally allowed to hold or
  move other people's money — that still requires a CBN license or a
  partnership with an already-licensed bank/PSB/MFB.

## Frontend

`public/` is a small static site served directly by Express (no build step):

| Page | What it's for |
|---|---|
| `index.html` | Marketing/landing page |
| `onboarding.html` | Merchant register/login (`?tab=login` or `?tab=register`) |
| `dashboard.html` | Logged-in merchant dashboard — see "Merchant dashboard" below |
| `pay.html` | Customer-facing checkout page rendered by the `payment.initialize` link; polls `GET /api/v1/checkout/:token/status`, and for test-mode checkouts offers a "simulate transfer" button that calls `POST /api/v1/checkout/:token/simulate` |
| `demo.html` | Public, no-signup demo of the checkout flow, served at `/demo`; talks only to `POST /api/v1/demo/checkout` |
| `admin.html` | Operator dashboard, served at `/admin`. Pool status + manual provisioning (authenticates client-side against `INFRA_ADMIN_KEY` only). Also has a "Stuck payments" table with resolve actions, which additionally require signing in with a named admin session (`POST /admin/auth/login`, role `finance`/`superadmin`) via a separate panel on the same page — see `adminUser.model.js` |
| `folder/*.html` | Marketing site pages — `products.html`, `pricing.html`, `developers.html`, `company.html`, `viewdocs.html`, and legal pages (`terms_of_service.html`, `privacy_policy.html`, `cookie_policy.html`) |

### Merchant dashboard (`dashboard.html`)

Single-page, tab-based dashboard styled after Paystack/Flutterwave's merchant
consoles. All data loads client-side from the session-authenticated
`/api/*` endpoints (`public/js/dashboard.js` + `public/js/api.js`):

| Tab | What it shows |
|---|---|
| Overview | Wallet balance, volume received, flagged count, paid-out total, a 14-day revenue bar chart, quick payment-link generator, recent transactions |
| Analytics | 30-day bar chart (received vs. paid out), a candlestick chart of daily transaction open/high/low/close, and computed business insights (average transaction value, success rate, busiest day, refund rate, open disputes, active subscriptions) |
| Transactions | Full transaction ledger with status filters and search |
| Customers | Merchant's end-customers |
| Refunds | Request a refund against a settled transaction; refund history |
| Disputes | Open disputes and evidence submission |
| Subscriptions | Plans, subscribing customers, and generated invoices |
| Settlements | Settlement schedule and status |
| Payouts | Request a payout; payout history |
| Settings | Business profile, API secret key regeneration, webhook URL |

Charts are rendered with [Chart.js](https://www.chartjs.org/) plus the
`chartjs-chart-financial` plugin (loaded from CDN in `dashboard.html`); all
chart data is computed client-side from the same `transactions`/`payouts`
arrays the rest of the dashboard already loads — no new backend endpoints
were needed. If the CDN is unreachable the dashboard degrades gracefully
(charts simply don't render; every other panel still works).

### Marketing site

Every marketing/legal page under `public/` and `public/folder/` carries a
floating "Try Live Demo" button (bottom-right) that links straight to
`demo.html`, so a visitor can try a real checkout without signing up. Every
"Documentation" link across the site points at `folder/viewdocs.html`,
which in turn links out to the live interactive API explorer
(`/api/docs`, generated from `docs/openapi.yaml`).

## Getting Started

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `MONGO_URI`, `JWT_SECRET` — required to run at all
   - `BANK_WEBHOOK_SECRET` — must match whatever bank partner is signing webhooks
   - `REXXPAY_BANK_BASE_URL`, `REXXPAY_BANK_ADMIN_KEY` — only needed if
     provisioning real accounts from an external RexxPay Bank instance rather
     than using the local mock bank
   - `REXXPAY_BANK_PAYOUT_SECRET` — signs outgoing payout instructions to
     RexxPay Bank; defaults to `BANK_WEBHOOK_SECRET` if unset
   - `LINKED_SERVICE_NAME` — how this service identifies itself in payout
     instructions; must match the `linkedService` value on the RexxPay Bank side
   - `INFRA_ADMIN_KEY` — required for the `/api/admin` routes (not the
     `/api/admin/cron/*` ones — see `CRON_TRIGGER_KEY` below)
   - `CRON_TRIGGER_KEY` — required for the `/api/admin/cron/*` routes.
     Deliberately separate from `INFRA_ADMIN_KEY` (see `.env.example`)
   - `ADMIN_JWT_SECRET` — required for named admin logins
     (`POST /api/admin/auth/login`) used by the money-moving admin
     actions (resolving stuck payouts/withdrawals/refunds, releasing/
     rejecting flagged transactions). Bootstrap the first account with
     `node scripts/create-admin-user.js <email> <role>`. Falls back to
     `JWT_SECRET` if unset, but set it separately in production
   - `REDIS_URL` — required for the BullMQ workers (webhook processing,
     merchant webhook delivery) AND for rate limiting (see
     `src/middleware/redisRateLimitStore.js`) — without it, rate limits
     reset per-process instead of being enforced globally
   - `SANCTIONS_DENYLIST_DEV` — optional, comma-separated names to exercise
     the flagging path locally (see `utils/sanctionsCheck.js`)
   - `MAX_SINGLE_PAYMENT_MINOR`, `MAX_DAILY_INBOUND_MINOR`,
     `VELOCITY_WINDOW_MINUTES`, `VELOCITY_MAX_COUNT`,
     `MAX_SINGLE_PAYOUT_MINOR`, `VIRTUAL_ACCOUNT_EXPIRY_MINUTES`,
     `DISPUTE_EVIDENCE_WINDOW_DAYS` — optional, override the defaults in
     `config/limits.js`
   - `POOL_MIN_THRESHOLD`, `POOL_TOPUP_COUNT` — optional, override the
     defaults in `config/limits.js` that control when
     `scripts/auto-provision-pool.js` tops up a bank's account pool
   - `PLATFORM_FEE_BPS`, `PLATFORM_FEE_FIXED_MINOR`, `PLATFORM_FEE_CAP_MINOR`
     — optional, override the default platform fee charged per transaction
     in `config/fees.js`
   - `SETTLEMENT_CUTOFF_MINUTES`, `SETTLEMENT_AVAILABILITY_DELAY_MINUTES`,
     `SETTLEMENT_BATCH_SIZE` — optional, control how long a confirmed
     payment sits before it's eligible to settle, the extra hold before
     it's payable, and the max transactions processed per batch (see
     `npm run run-settlement`)
3. `npm run dev` — starts the API server
4. `npm run worker:dev` — starts the BullMQ webhook worker (separate process; without
   it, inbound bank webhook events are persisted and queued but never processed)
5. `npm run worker:merchant-webhooks` — starts the BullMQ merchant-webhook
   delivery worker (separate process; without it, outbound notifications
   to merchants' `webhookUrl` are durably recorded but never actually
   sent — see `dispatchMerchantWebhook()`)
6. `npm run worker:outbox` — starts the outbox worker (separate process;
   without it, `OutboxEvent` documents are created atomically with every
   inbound payment but never dispatched — see the `outbox` row above)

## Scripts

Operational scripts, run manually or on a schedule (all read `.env` the same
way the server does):

| Command | What it does |
|---|---|
| `npm run provision-bank-pool [count]` | One-time (or top-up) provisioning of real pool accounts from RexxPay Bank. Requires `REXXPAY_BANK_ADMIN_KEY`. Default count: 10. |
| `npm run auto-provision-pool` | Checks each bank partner's available-account count and tops it up by `POOL_TOPUP_COUNT` whenever it drops to or below `POOL_MIN_THRESHOLD`. Intended to run on a cron. |
| `npm run release-stale-accounts` | Releases virtual accounts stuck in `assigned` past `VIRTUAL_ACCOUNT_EXPIRY_MINUTES` with no payment, back to the available pool. Intended to run on a cron every 5–15 minutes. |
| `npm run reactivate-expired-accounts` | Companion to the release job — moves `deactivated` accounts whose `cooldownUntil` has passed back to `available` so they can be reassigned. |
| `npm run generate-invoices` | Sweeps subscriptions with a due `nextBillingDate`, creates the `Invoice` + a virtual account for the customer to pay it into. Intended to run on a cron. Currently a no-op until at least one merchant creates a `Plan` and subscribes a customer to it — safe to leave running either way. |
| `npm run reconcile -- path/to/settlement-file.json` | Compares local `Transaction` records against a bank settlement export and reports mismatches in both directions, scoped to the same date range as the export (previously compared against SwiftPay's entire history, which reported old transactions as false discrepancies on every run). Useful for an ad hoc/manual comparison against a settlement file obtained some other way; for the automated daily version, see `fetch-and-reconcile` below. |
| `npm run fetch-and-reconcile` | Pulls RexxPay Bank's confirmed-deposit export for a date range directly (no temp file, no child process) and runs the same comparison as `reconcile` above. This is the one actually scheduled on a cron — see the Admin cron table below. |
| `npm run reconcile-outbound` | Checks with the bank directly on any payout/withdrawal/refund stuck `reserved`/`processing`/`ambiguous` past a threshold, and recovers what it safely can. **Previously not wired to any cron route at all** — it existed as a script but only ever ran if someone remembered to run it by hand; now scheduled via `/api/admin/cron/reconcile-outbound`. |
| `npm run run-settlement` | Runs one settlement cycle now: moves eligible transactions `pending_settlement → settled → available` and writes a `SettlementBatch` record for each phase. Intended to run on a cron; can also be triggered ad hoc via `POST /api/v1/admin/settlement/run`. |
| `node scripts/create-admin-user.js <email> <role> [password]` | Bootstraps a named admin account (`superadmin`/`finance`/`support`) for the money-moving admin actions. Deliberately a CLI script, not an HTTP endpoint — see `adminUser.model.js`. If password is omitted, a random one is generated and printed once. |

`webhook.processor.js` also self-heals on server startup: any webhook event
left mid-processing after a crash is picked up by `redriveStuckEvents()`
automatically — no manual step needed for that one.

## Production Setup (Render + Hostinger cron)

Current live deployment: `checkout-swiftpay` web service on Render
(`https://checkout-rexxpay.onrender.com`), Free instance type.

### Redis (required — webhook processing silently does nothing without it)

The durable webhook queue (`src/queue/webhookQueue.js` + `webhookWorker.js`)
requires Redis. Without `REDIS_URL` set, it falls back to
`redis://127.0.0.1:6379`, which doesn't exist in this deployment — every
webhook then gets persisted to Mongo (`WebhookEvent`, `status: 'queued'`)
but **never processed**: no transaction gets recorded, no merchant webhook
fires, and the failure is silent (only logged, never surfaced anywhere).

Fixed by provisioning a Render **Key Value** instance (Redis-compatible),
Free tier, same region (Oregon) as the web service, and setting
`REDIS_URL` to its **Internal** connection string on the `checkout-swiftpay`
environment. `redriveStuckEvents()` (runs on every server boot) then
sweeps up anything that got stuck before the fix and re-processes it
automatically.

Free-tier Redis has no persistence (`Off`) and can restart (Render
maintenance, OOM at 25 MB, etc.) — this is an accepted trade-off, not a
bug: the durable copy of every webhook event lives in Mongo first, so a
Redis restart only loses the "go process this" notification, not the
underlying data. `redriveStuckEvents()` on the next SwiftPay server
restart re-sends that notification. The gap: if Redis restarts but
SwiftPay's own server doesn't restart for a while after, an event can sit
stalled (silently) until SwiftPay's next deploy/restart triggers the sweep.

### Cron (scheduled jobs, run externally via Hostinger)

Render Cron Jobs cost money (no free tier for the service type itself —
~$1/mo minimum per job, so ~$5–6/mo total for 5 jobs). Instead, the same
scripts above are triggered via plain `GET` requests to admin-key-guarded
routes on the running web service (`src/modules/admin/admin.routes.js`,
`/cron/*`), called externally by cron jobs on existing Hostinger hosting
(same pattern already used to keep RexxPay Bank's `/health` warm).

| Route | Mirrors | Schedule |
|---|---|---|
| `GET /api/admin/cron/release-stale-accounts` | `scripts/release-stale-accounts.js` | every 10 min |
| `GET /api/admin/cron/reactivate-expired-accounts` | `scripts/reactivate-expired-accounts.js` | every 10 min |
| `GET /api/admin/cron/auto-provision-pool` | `scripts/auto-provision-pool.js` | every 15 min |
| `GET /api/admin/cron/run-settlement` | `scripts/run-settlement.js` | daily, `10 0 * * *` |
| `GET /api/admin/cron/generate-invoices` | `scripts/generate-invoices.js` | daily, `0 0 * * *` |
| `GET /api/admin/cron/fetch-and-reconcile` | `scripts/fetch-and-reconcile.js` | daily, `30 0 * * *` (after settlement/invoices) |
| `GET /api/admin/cron/reconcile-outbound` | `scripts/reconcile-outbound.js` | every 15 min — **previously not scheduled at all**; a stuck payout/withdrawal/refund only ever got recovered if someone remembered to run the script by hand |

All guarded by `requireCronKey` (`?cronKey=` query param, or `x-cron-key`
header), a **separate** secret from `INFRA_ADMIN_KEY` - see
`CRON_TRIGGER_KEY` in `.env.example` for why. Hostinger cron command
format (needs `curl`, not a bare URL — cron doesn't know what to do with
a URL on its own):
```
curl "https://checkout-rexxpay.onrender.com/api/admin/cron/<route>?cronKey=YOUR_CRON_TRIGGER_KEY"
```

After adding a job to the schedule above, also check `GET
/api/admin/cron/health` (`x-admin-key` header) periodically — it reports
whether each job in this table has actually run recently, so a silently
broken external scheduler doesn't go unnoticed.

`scripts/reconcile.js` itself is deliberately **not** a separate cron
entry — it's the comparison logic `fetch-and-reconcile` calls internally
after pulling the bank's export; it takes a settlement file as input, so
it's not something a bare scheduled `curl` can drive on its own. Its
date-range handling used to compare the bank's export window against
SwiftPay's *entire* transaction history (reporting old transactions as
false discrepancies on every run) — fixed to scope the comparison to the
same window as the export, see `runReconciliation()`.

## Known gaps (found during Aug 2026 ops session, not yet fixed)

- **The transactional outbox covers one specific flow, not every
  financial-commit-to-external-effect gap.** `OutboxEvent` (see `outbox`
  above) guarantees inbound-payment side effects survive a crash. What it
  does NOT do: there's no equivalent outbox for the outbound direction
  (payout/withdrawal/refund provider instructions) — that gap is
  mitigated by the ambiguous-state handling in `payout.service.js`/
  `withdrawal.service.js`/`refund.service.js` plus
  `scripts/reconcile-outbound.js`, which is a different (reconciliation-
  based) mechanism, not the same atomic-enqueue guarantee. There's also
  no dead-letter queue beyond an `OutboxEvent.status = 'failed'` value —
  a permanently-failed event needs a human to notice the critical audit
  log and act, there's no separate alerting integration.
- **Distributed locking covers the admin/cron routes, not the ad hoc
  `scripts/*.js` CLI entry points.** If someone runs
  `node scripts/run-settlement.js` by hand at the same moment the cron
  route also fires, `withCronLock` only protects the HTTP route path —
  the CLI script calls the same underlying function directly and has no
  lock of its own.
- **Audit-log immutability is enforced at the Mongoose layer only.**
  `AuditLog`'s update/delete hooks (see `auditLog.model.js`) stop this
  application's own code from mutating a record, not someone with direct
  database credentials using the raw MongoDB driver or a backup/restore
  tool. Real tamper-resistance needs DB-level user permissions or an
  external WORM store.
- ~~**`reconcile.js` has no automated input.**~~ **Fixed** — see
  `scripts/fetch-and-reconcile.js` and the `fetch-and-reconcile`/
  `reconcile-outbound` cron routes above.
- **`deactivateVirtualAccount()` doesn't tell RexxPay Bank.** ~~In
  `virtualAccount.service.js`...~~ **Stale — already fixed in the current
  code.** `deactivateVirtualAccount()` (in `virtualAccount.service.js`)
  does call `deactivateBankPoolAccount(account.accountNumber)` for live
  accounts, with `ambiguous`/`failed` `bankSyncStatus` handling on
  failure, same as its siblings. Re-verified against the actual source
  during the Sep 2026 transfer-only audit below — leaving this line here
  only so a future read of this file doesn't reintroduce a fix for an
  already-fixed bug.
- **That same call 404s in production even where it exists.**
  `[bankPartner] failed to deactivate account 1074337293 on RexxPay Bank:
  Request failed with status code 404` was observed live. Root cause not
  yet confirmed — needs checking RexxPay Bank's own
  `pool-accounts/:accountNumber/deactivate` route (does it 404 because
  RexxPay Bank already auto-deactivates on deposit and the account no
  longer matches whatever status the route filters on, or is it an
  account-number/routing mismatch).
- **Amounts aren't enforced by the bank.** `assignVirtualAccount()` stores
  `amountExpected` only in SwiftPay's own DB; RexxPay Bank's
  account-provisioning API has no `expectedAmount` field, so it can never
  reject a mismatched transfer at the banking layer the way some real BaaS
  partners (Providus, Wema, etc.) do. SwiftPay's `partial`/`over` status
  logic in `transaction.service.js` is therefore the *only* safeguard —
  correct as a fallback, but not a substitute for bank-level enforcement
  if that's ever wanted.
- **Invoices have no push notification.** `markInvoicePaidByTransaction()`
  and `generateDueInvoices()`/`markOverdueInvoices()` update `Invoice`
  records silently — unlike `transaction.success`, there's no
  `dispatchMerchantWebhook()` call for `invoice.created`/`invoice.paid`/
  `invoice.overdue`. Merchants currently only see invoice state by
  checking the dashboard (`dashboard.js` → `GET
  /api/subscriptions/invoices`) or polling the API themselves.

### Sep 2026 transfer-only production audit

Found and fixed:

- **No dedicated rate limits on money-moving/admin routes.** Payout,
  withdrawal, refund, payment init/verify, and every `/admin/*` route
  shared only the generic 300/req/15min limiter with all other traffic.
  Added `moneyMovementLimiter`, `paymentLimiter`,
  `accountResolutionLimiter`, `adminLimiter` (`rateLimit.middleware.js`)
  and wired each into its routes.
- **Bank-account-name resolution didn't exist at all, anywhere** — no
  `GET /banks`, no `POST /bank/accounts/resolve`, and
  `Recipient.accountName` was stored verbatim from merchant input and
  used directly for live payouts. Added `config/banks.js` (static NIBSS
  directory) + the two endpoints (new `bankPartner/bank.*` files);
  `Recipient` now has `verified`/`verificationMethod`, creation attempts
  `bankPartner.service.resolveBankAccount()` and only ever trusts the
  *provider's* returned name, and `payout.service.js` refuses live-mode
  payouts to an unverified recipient (falls back to
  `PATCH /admin/recipients/:id/verify`, finance/superadmin-only, when
  provider resolution isn't available). Built the standard way any real
  bank/BaaS integration does this: a signed outbound request, the
  provider's returned name is the only source of truth (never the
  merchant's input), and any error fails closed rather than fabricating
  a name. Whether RexxPay Bank's specific endpoint path matches what's
  called here is a deployment/config detail to confirm against RexxPay
  Bank directly, not a gap in the approach.
- **Inbound webhook currency wasn't validated.** `webhook.processor.js`
  defaulted an absent/wrong `currency` field straight through to
  `recordIncomingPayment()` with no check, even though inbound collection
  is NGN-only by construction (no `currency` field exists on
  `VirtualAccount` at all). Now rejects (fails the `WebhookEvent`,
  doesn't touch the ledger) any inbound webhook claiming a currency other
  than NGN, with a critical audit log entry.
- **`processEvent()` (the core webhook-matching/dedup logic) had zero
  test coverage** — only signature verification was tested. Added
  `tests/integration/webhookProcessor.test.js` covering unrecognized
  account, the new currency check, and the happy path.
- **`settlement.service.js` (the pending_settlement → settled →
  available pipeline) mixed test and live transactions in the same
  batch.** Neither `runSettlePhase` nor `runMakeAvailablePhase` filtered
  by `mode` — each transaction still credited the *correct* per-mode
  wallet (no wallet-level bug), but a `SettlementBatch`'s own
  `totalAmount`/`transactionCount` was a meaningless mix of real and
  sandbox money, useless for reconciliation/audit. Added `mode` to
  `SettlementBatch`, threaded it through both phases and
  `runSettlementCycle`, and updated all three call sites (cron route,
  manual admin trigger, `scripts/run-settlement.js`) to run live and
  test separately. This subsystem had **zero test coverage** before this
  pass; added `tests/integration/settlement.test.js`.
- **`scripts/reconcile.js` had the same bug class it had already fixed
  once for date range (see "High #19" above), but for mode.** The
  bank-vs-ours comparison query had no `mode` filter, so a successful
  test-mode transaction — which never touches a real bank — would show
  up as a permanent false-positive "in ours, not in bank" on every run.
  Bank settlement exports are inherently live-only, so `mode: 'live'` is
  now the query default (overridable). Added
  `tests/integration/reconcile.test.js` (also previously untested).

Still open at the end of this pass — see the stage-by-stage report in
the conversation that produced this section for the full audit
findings; picking back up from transaction state-machine legality
(req. #7), settlement double-settlement/reversal guards (req. #13), and
reconciliation (req. #14) next.

### Stage 4 (same audit, continued): CORS/SSRF re-check, disputes review, false marketing claims

- **CORS, SSRF guard (webhook delivery), dispute handling**: reviewed
  in full, no bugs found. CORS uses an explicit origin allowlist (never
  reflects `*` with `credentials: true`). `ssrfGuard.js` re-resolves DNS
  at both webhook-URL-set time and every send (defeats DNS-rebinding),
  and `merchantWebhookWorker.js` sets `maxRedirects: 0` (defeats
  SSRF-via-redirect). `dispute.service.js` correctly uses a partial
  unique index for "one open dispute per transaction" and
  `debitWalletForDispute`'s negative-balance allowance is a deliberate,
  correct match for real chargeback mechanics.
- **The public marketing site (`public/index.html`) violated req. #31/
  #32 directly** — advertised Cards, Mastercard, Verve, Mobile Money,
  USSD, and QR Code payments, none of which this platform implements.
  Worse: a "Trusted by leading businesses" section listed Visa,
  Mastercard, Verve, MTN, Airtel, and 9mobile as if they were partners/
  customers — a false-affiliation claim with real, named companies. Also
  claimed **PCI DSS Level 1 certification** and "99.99% Uptime" — neither
  backed by anything in this codebase, and a false PCI claim on a live
  payment site is a real compliance/legal liability, not just marketing
  fluff. Rewrote the hero, feature list, payment-methods section, security
  section, and footer tagline to describe only what's real
  (bank-transfer-only, signed webhooks, TLS, double-entry ledger, audit
  logging) and to match the required copy ("Transfer-based payment
  infrastructure for merchants."). Fabricated traction numbers ($2.5B+
  processed, 10,000+ businesses, 15 countries, "thousands of businesses")
  were also removed as unverifiable claims. `public/dashboard.html`
  (the actual merchant-facing app, as opposed to the marketing site) was
  already clean — no false claims found there. Note: the footer links to
  `folder/security.html`, which doesn't exist (broken link, not created
  as part of this fix — writing a security policy page's content wasn't
  part of the scope here and would itself risk new unverified claims).
- **OpenAPI (`docs/openapi.yaml`) updated** to match everything added in
  this audit: `GET /banks`, `POST /bank/accounts/resolve`,
  `PATCH /admin/recipients/:id/verify`, `Recipient.verified`/
  `verificationMethod`/`verifiedAt`, and `SettlementBatch.mode` +
  the `mode` query param on both settlement admin routes. Validated with
  `python3 -c "import yaml; yaml.safe_load(...)"` (no `js-yaml`/`yamljs`
  available without `npm install`, but this parses the same document
  structure). README's endpoint list updated to match.

### Stage 5 (same audit, continued): the payment amount contract itself, and provider failure-recovery re-check

- **`POST /payments/initialize` violated req. #2 (the contract requirement
  the spec called out first and marked critical).** `initializePayment()`
  did `Math.round(Number(amount) * 100)`, treating the incoming `amount`
  as **major units (naira)** and silently multiplying it — the opposite
  of the required/documented contract, and the opposite of every other
  money-moving endpoint in this API (payouts, withdrawals, refunds all
  correctly take raw integer minor units already).
  `assignVirtualAccount()` downstream even already asserts
  `amount_must_be_a_positive_integer_in_minor_units`, confirming the rest
  of the system universally expected minor units — this endpoint was the
  one outlier. A caller correctly following the spec's own worked example
  (`amount: 100000` meaning ₦1,000) would have had it silently amplified
  100x to ₦100,000. Fixed: `initializePayment()` now takes `amount` as
  minor units directly (integer-checked, no multiplication). Its two
  existing callers that collect naira from a human —
  `public/js/dashboard.js`'s "create payment link" form and
  `demo.service.js`'s `startDemoCheckout` (itself fed by a naira-based
  public demo form) — now do their own naira→kobo conversion before
  calling it, so their actual behavior/stored amounts are unchanged; only
  a direct API caller sending kobo per spec is affected, and it's now
  correct instead of amplified. Updated `docs/openapi.yaml`. Added
  `tests/integration/paymentAmountContract.test.js` (zero prior test
  coverage existed for this endpoint's amount handling at all — this is
  exactly the kind of bug requirement #2 explicitly said to "add tests
  proving").
- **`rexxPayBankClient.js` re-checked in full against req. #28** (provider
  timeout/500/malformed response). No bugs found: retries on
  429/502/503/504 and network errors, honors `Retry-After`, exponential
  backoff with jitter, and — critically — anything non-retryable or
  retry-exhausted is marked `ambiguousOutcome: true` rather than assumed
  failed, matching req. #18's "never auto-reverse on ambiguous" rule
  exactly. One assumption worth flagging (not a bug, a provider-contract
  question): retries reuse the same `idempotencyKey` in the request body,
  which only prevents a double-payout at the bank if RexxPay Bank itself
  dedupes on that key — standard behavior for a real payment rail, but
  unconfirmed here for the same reason `resolveBankAccount()`'s endpoint
  is unconfirmed.
- Subscriptions/invoices module reviewed — `generateDueInvoices()` and
  `markInvoicePaidByTransaction()` are correct (unique `(subscription,
  periodStart)` index prevents double-billing; invoice-paid only fires
  for `success`/`over` transactions, never `partial`, so an
  underpayment can't mark a subscription paid). No changes made here
  beyond what's already logged as a known gap (no push notification for
  invoice events).

### Stage 6 (same audit, continued): admin ops tooling (req. #24) had no browsing at all

Every existing `/admin/*` route was an *action* (resolve a stuck
payment, verify a settlement account, set fees) — there was no way to
browse the underlying data short of connecting to Mongo directly, and no
manual redrive for a permanently dead-lettered webhook event
(req. #5 explicitly asks for one). Added:

- `GET /admin/webhook-events` (`?status=&source=&limit=`) — `status=failed`
  is effectively the dead-letter queue.
- `POST /admin/webhook-events/:id/redrive` (finance/superadmin-only) — new
  `webhook.processor.js#redriveFailedEvent()`: resets a failed event and
  re-enqueues it, first removing any stale terminal BullMQ job under the
  same ID (job IDs are pinned to the event's Mongo `_id`, so re-adding
  without removing the old one first would be a no-op against a job stuck
  in a terminal state). Distinct from the existing `redriveStuckEvents()`,
  which recovers events crashed mid-processing, not dead-lettered ones.
- `GET /admin/audit-logs` (`?actorType=&action=&entityType=&entityRef=&severity=&limit=&before=`)
  — `auditLog.service.js` had a `record()` but no way to ever read anything
  back; added `list()`.
- `GET /admin/merchants` (`?isVerified=&limit=`) — same secret-hash
  exclusion a merchant's own profile view already uses.

Updated `docs/openapi.yaml` and README's endpoint list. Added
`tests/integration/adminOpsTooling.test.js` (audit-log filtering/limit
capping, merchant-listing secret exclusion, and redrive - including the
not-yet-failed rejection path and the stale-job-removal path, mocking
`webhookQueue` since this sandbox has no Redis).

**Update (Stage 11 below): this frontend gap is now closed** — the four
endpoints listed above are wired into `admin.html`/`admin.js`.

### Stage 7 (same audit, continued): wired account resolution into the merchant dashboard's payout form

The dashboard's existing "Request a payout" form
(`public/dashboard.html`) collects `destinationAccountName` as free
text with zero verification, feeding the ad hoc (non-recipient)
payout path in `payout.service.js` - which already best-effort-resolves
and audits server-side (Stage 1), but the merchant got no feedback
either way. Wired `POST /bank/accounts/resolve` into
`public/js/dashboard.js`: on blur of bank code / account number, it
auto-verifies and locks the account-name field to the provider's
returned name (clearing/unlocking again if either input changes
afterward); if resolution isn't available it falls back to manual entry
with a visible "could not auto-verify" notice rather than silently
pretending everything's fine.

**Update (Stage 10 below): this gap is now closed** — a Recipients
panel was added to the dashboard, with the create/list/deactivate UI
this note originally said was missing.

### Stage 8 (correction, made in conversation after this stage was
originally written): the entire premise of this stage was withdrawn.

This section originally cited an unsolicited web search of a
speculative-looking public GitHub page as if it were authoritative
documentation of RexxPay Bank's real API surface, and used it to hedge
`resolveBankAccount()`/`checkPayoutStatus()` more than their actual code
quality warranted. That search wasn't asked for, the source was thin
(a personal profile README, not RexxPay Bank's own API docs), and
leaning on it contradicted an explicit instruction to build the
integration the standard real-world way rather than second-guess it
against RexxPay-specific speculation. Both functions were already built
correctly per that standard: signed outbound requests, the provider's
own response is the only source of truth for a resolved name, and any
error fails closed rather than inventing one. Whether RexxPay Bank's
exact endpoint paths match what's called is a deployment/config detail
to confirm directly against RexxPay Bank, not a design gap - the
original Stage 1 comments already say this correctly; the extra hedging
layered on top in this stage has been removed from the code comments and
from `docs/openapi.yaml`.

### Stage 9 (same audit, continued): invoice lifecycle webhooks

Closed a gap that had been logged in this README since before this audit
session started: invoice state changes never fired a merchant webhook,
unlike every other event type. Added to `subscription.service.js`:
- `invoice.created` — dispatched from `generateDueInvoices()` right after
  the invoice + its virtual account are created. Caught/logged, not
  propagated, since one webhook-enqueue failure must not stop the rest of
  the billing sweep from running.
- `invoice.overdue` — dispatched from `markOverdueInvoices()`, same
  catch/log treatment (no outer loop-level try/catch existed here before,
  so this was needed to avoid one failure ending the whole sweep).
- `invoice.paid` — dispatched from `markInvoicePaidByTransaction()`,
  which runs inside the outbox worker's handling of the `mark_invoice_paid`
  event (itself atomically enqueued with the financial commit). Left
  uncaught here deliberately, unlike the other two: this one runs inside
  the outbox's own retry/backoff (same as the existing
  `dispatch_merchant_webhook` case), so a failure to even enqueue the
  delivery should propagate and get retried, not be silently dropped.
  Re-finding the invoice by `status:'pending'` is what makes a retry safe
  to repeat.

Added `tests/integration/invoiceWebhooks.test.js` covering all three
dispatch points plus the "merchant has no webhookUrl configured" no-op
case. `merchantWebhookQueue.js` needs real Redis with
`maxRetriesPerRequest: null` (retries indefinitely rather than failing
fast), so it's mocked in the test the same way `webhookQueue.js` is
mocked elsewhere this session.

### Stage 10 (same audit, continued): Recipients dashboard UI, and wired it into the payout form

Recipients existed only as a raw API before this — no dashboard UI to
create, view, or deactivate one, and the payout form had no way to pay a
saved recipient at all (only ad hoc destination entry). Added to
`public/dashboard.html`/`public/js/dashboard.js`:
- A "Recipients" panel (create form + table) in the Payments tab, showing
  each recipient's verification status (`✓ bank-verified` /
  `✓ admin-verified` / `Needs verification`) and a deactivate action.
- Refactored the account-name auto-resolve logic (Stage 7) out of an
  inline IIFE into a reusable `wireAccountResolve()`, wired to both the
  payout form and the new recipient form instead of duplicating it.
- The payout form now has a "Pay to" selector: saved, **verified**,
  active recipients populate it (unverified ones are visible in the table
  but deliberately not offered here, matching `payout.service.js`'s own
  live-mode enforcement from Stage 1); selecting one sends `recipientCode`
  instead of raw destination fields, and hides/un-requires those fields.
  Choosing "New destination" restores the original ad hoc behavior
  unchanged.

No new backend logic here — this only makes existing, already-correct
API surface (Stages 1 and 7) actually reachable from the dashboard.

### Stage 11 (same audit, continued): admin back-office UI

Wired up the four admin ops endpoints from Stage 6 into
`public/admin.html`/`public/js/admin.js`, matching that file's existing
conventions exactly (`adminApi()` helper, `.pill`/`.card` styling, the
`err.needsSession` pattern already used for stuck-payment resolution):
- **Webhook events** table with a status filter (defaults to `failed`,
  i.e. the dead-letter view) and a per-row "Redrive" button, gated behind
  the same named-admin-session check the existing stuck-payment resolve
  actions use (`redriveFailedEvent` requires `finance`/`superadmin`
  server-side regardless, but the UI checks up front for a better error
  than a raw 403).
- **Audit logs** table with a severity filter.
- **Merchants** table (business name, email, plan, verified status).

All three are read-only lists using just the `x-admin-key` (no named
session required), consistent with how the existing pool-status view
works. No backend changes — Stage 6 already built and tested this API
surface, this closes the "not yet built" note left at the end of that
stage.

At this point every gap flagged across this entire audit session has
either been fixed or is explicitly, deliberately out of scope (see the
"still open" items in the final summary given in conversation).

### Stage 12 (same audit, continued): the two remaining items, actually done

**#5 — `deactivateVirtualAccount()` 404 in production.** Re-examined
`bankPartner.service.js#syncBankAccountStatus` line by line and formed a
concrete, testable hypothesis: RexxPay Bank likely already transitions/
reclaims a pool account server-side once a deposit lands on it (see how
`maintainAccountPools`/`assignBankPoolAccount` treat pool accounts
elsewhere in this file), so by the time SwiftPay's own `deactivate` call
arrives - via the `deactivate_virtual_account` outbox event, itself only
enqueued *after* a successful payment already landed - the account may
already be gone on RexxPay's side. A 404 in that situation means
"already done," not "failed": deactivation is inherently idempotent, the
same way a well-behaved DELETE returning 404 for an already-deleted
resource isn't a real failure for the caller. Fixed: a 404 specifically
on the `deactivate` action (not `assign`/`release` - scoped narrowly) is
now treated as an idempotent success, logged at `info` rather than
`error`, with the log message explicit about the assumption so it stays
falsifiable if wrong. Added
`tests/integration/bankAccountDeactivateIdempotency.test.js` (mocks
`axios` directly - the one live-mode path in this whole test suite,
since everywhere else deliberately sticks to `mode:'test'` to avoid
needing to mock the bank client at all), covering: the 404-is-success
case, a 500 still failing as a real ambiguous error, a 404 on `release`
NOT being treated as idempotent (proves the scoping holds), and the full
`deactivateVirtualAccount()` path end-to-end. **This is still a
hypothesis, not a confirmed root cause** - I don't have access to
RexxPay Bank's own logs. But it's the correct behavior regardless of
whether this specific hypothesis is right: an idempotent operation
should treat "already in target state" as success, full stop.

**#4 — broken `folder/security.html` link.** Wrote the actual page,
matching the existing legal-page template exactly. Kept it to only
things this session actually verified are true: TLS, hashed/rotatable
API keys with last-used tracking (Stage 3), webhook signature
verification and SSRF-hardened delivery (Stage 4), the double-entry
ledger and audit logging, and per-category rate limiting (Stage 1) -
plus an explicit, prominent disclaimer that this describes technical
practices only and is **not** a compliance certification of any kind,
directly addressing the exact failure mode fixed on the homepage in
Stage 4 (the fabricated PCI-DSS claim). While building it, found a
real, separate, higher-impact bug: every page under `public/folder/`
(`terms_of_service.html`, `privacy_policy.html`, `cookie_policy.html`,
`company.html`, `pricing.html`, `products.html`, `developers.html`,
`viewdocs.html`) referenced `js/site-nav.js` with a relative path that
404s from within `/folder/` (the real file lives at `public/js/`, one
directory up). That script is what removes `.policy-card`'s initial
`opacity:0` scroll-in state - so **every one of those pages was
rendering blank/invisible to real visitors**, not just missing a
hamburger menu. Fixed the path (`../js/site-nav.js`) in all 9 files
(the 8 existing plus the new `security.html`). Also fixed the same stale
"Modern Payment infrastructure for Africa" footer tagline (Stage 4's
fix only touched `index.html`) across all 8 pre-existing pages.

### Stage 13: regression review across all 12 stages

Went back through every file touched this session specifically looking
for interaction bugs between changes made at different stages, not new
features. Checked: route mount ordering, duplicate imports/exports,
brace/div balance on every edited file, cross-file field-name agreement
between backend responses and frontend rendering, schema-default
behavior for pre-existing documents against newly-added fields, and
error-message strings against any frontend code that might special-case
them.

**Found and fixed one real regression**: `/admin/settlement/*` requests
were being rate-limited **twice**. Stage 1 added `apiV1.use('/admin',
adminLimiter, adminRoutes)` and, separately, applied the same
`adminLimiter` again to `apiV1.use('/admin/settlement', adminLimiter,
settlementRoutes)`. Since Express runs every matching `app.use()`
middleware regardless of which router ultimately handles the request,
and `/admin/settlement/...` matches the `/admin` prefix too, every
settlement admin request was consuming two hits against the same
60-req/15-min budget - silently halving it to an effective 30. Removed
the redundant second `adminLimiter` (the one at the `/admin` mount
already covers it).

**Found and fixed one consistency gap** (not a functional bug, but a
real inconsistency): the new `redriveWebhookEvent()` admin.js handler
didn't match the richer, already-established error-handling pattern
used by the existing `resolveStuckPayment()` (which specially handles a
named admin session expiring *between* the initial check and the actual
API call, with a distinct "session expired" message and state cleanup).
Aligned it to match exactly.

**Explicitly checked and confirmed correct, not a bug**: the ad hoc
payout path's best-effort `resolveBankAccount()` call adds up to a 15s
timeout to live ad hoc payouts if the provider call errors or times out -
worth being aware of in production, but it's a bounded, non-blocking-
to-correctness cost of a deliberate best-effort attempt, not a bug to
fix.

No other regressions found. Everything else checked out: no duplicate
route registrations or imports anywhere, all edited files balanced
(braces/divs), Mongoose schema defaults correctly backfill the new
`SettlementBatch.mode` and `Recipient.verified`/`Merchant.*KeyLastUsedAt`
fields for documents that predate this session, and every frontend
field reference (`res.data.account_name`, `r.verificationMethod`, etc.)
matches its backend response shape exactly.

### Stage 14: bugs found by an actual `npm test` run (first real execution this whole session)

The user ran `npm test` for real for the first time. Two genuine,
pre-existing bugs surfaced (both predate this audit - one in transaction
commit/abort logic that predates this session entirely, one in a test
file this session's own `withdrawalAmbiguousOutcome.test.js` had copied
the broken pattern of from an existing file):

1. **`MongoTransactionError: Cannot call abortTransaction after calling
   commitTransaction`**, in the concurrent-idempotency-key race tests for
   payout, withdrawal, and refund. Root cause: when two concurrent
   requests race on the same idempotency key, MongoDB sometimes detects
   the unique-index conflict *at commit time* rather than at the write -
   so `commitTransaction()` itself throws. Every one of the 8
   session/transaction blocks across `payout.service.js`,
   `withdrawal.service.js`, and `refund.service.js` unconditionally
   called `abortTransaction()` in their catch block regardless of why the
   error occurred - but the MongoDB driver refuses to abort a session
   once commit was attempted, so that call itself threw a *second*, new
   error ("Cannot call abortTransaction after calling commitTransaction")
   that masked the real one and broke the E11000 idempotency-conflict
   recovery path entirely (the actual point of the test). Fixed by adding
   a `committed` flag, set immediately before each `commitTransaction()`
   call, that guards every corresponding `abortTransaction()` call.
2. **`jest.mock()` scoping violation** in `payoutAmbiguousOutcome.test.js`
   (pre-existing) and this session's own `withdrawalAmbiguousOutcome.test.js`
   (which had mirrored the exact same pattern): Jest hoists `jest.mock()`
   factories above regular variable declarations and refuses to let them
   close over an out-of-scope variable unless its name is prefixed with
   `mock`. Both files used `finalizeReservedDebitShouldThrow`/
   `finalizeReservedDebitCallCount`, which don't qualify. Renamed both to
   `mockFinalizeReservedDebit*` in both files.
3. **"Client must be connected before running operations" console noise**
   during the same run, from `refund.service.js`'s rare ambiguous-
   outcome save-failure audit-log path - very likely a downstream
   symptom of #1 (the abort-after-commit crash throwing execution into
   an unexpected error path that isn't normally reached in that test's
   flow), not confirmed independently resolved without a fresh run.

**Important caveat about this test run itself**: it was against a
separate local copy (`C:\Users\emman\swiftpay`), not the audited code -
the suite count (12) matches the pre-audit test count exactly, none of
the ~11 test files added this session appeared in the run. The bugs
above are real and now fixed in this codebase regardless, since they're
in shared logic this session built on top of without rewriting, but the
~11 new test files from this session have still never actually been
executed anywhere.

## Automated tests

```
npm test
```

Two kinds, both under `tests/`:

- **Unit tests** (`tests/*.test.js`) — pure logic, no database: fee
  calculation, limits, sanctions stub, webhook signature verification,
  admin key/session middleware, idempotency fingerprinting, SSRF guard.
  Fast, no setup required.
- **Integration tests** (`tests/integration/*.test.js`) — spin up a real
  (in-memory) MongoDB replica set via `mongodb-memory-server`, because
  several of the guarantees this repo depends on (write-conflict
  serialization, atomic compare-and-increment, multi-document
  transactions) genuinely cannot be verified against a mocked model —
  there's no real storage engine underneath to conflict. Covers:
  - `subaccountSettlement.concurrency.test.js` — two simultaneous
    settlement requests can't drain the same balance twice
  - `concurrentFinancialRequests.test.js` — concurrent payout/
    withdrawal/refund requests: same idempotency key dedupes to one
    record; different keys with the same net effect (refunding the same
    transaction) are stopped by the atomic refund-headroom claim, not
    just the idempotency check
  - `payoutAmbiguousOutcome.test.js` — a payout the bank already
    accepted, where SwiftPay's own local write then fails, is parked as
    `ambiguous` and never auto-reversed
  - `outbox.test.js` — the transactional outbox: atomic enqueue with the
    financial commit, no duplicate outbox events on a replayed webhook,
    a worker that never ran (or ran late) still finds the work waiting,
    recovery after a worker crashes mid-attempt, retry-with-backoff vs.
    permanent failure after `maxAttempts`

**These have not been executed against a real Node install in this
environment** — written and reviewed against the actual implementation,
not run. Run `npm install && npm test` yourself before trusting them,
same as everything else in this repo.

## Testing the full flow locally

```bash
# 1. Register a merchant (save the secretKey from the response)
curl -X POST localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"businessName":"Test Store","email":"a@b.com","password":"pass1234"}'

# 2. Create a customer
curl -X POST localhost:5000/api/v1/customers \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"fullName":"Jane Doe","email":"jane@example.com"}'

# 3. Assign a virtual account to that customer
curl -X POST localhost:5000/api/v1/virtual-accounts \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"customerId":"<customer_id_from_step_2>"}'

# 4. To simulate a transfer without a real bank, use the hosted checkout
# flow below instead — creating a virtual account directly (step 3) has no
# standalone simulate shortcut anymore; only a real signed bank webhook
# (POST /api/v1/webhooks/bank) can complete it.

# 5. Check the wallet balance
curl localhost:5000/api/v1/wallet -H "Authorization: Bearer sk_test_xxx"
```

### Hosted checkout flow (alternative to steps 2–3 above)

```bash
# Creates the customer + assigns a virtual account in one call, returns a
# checkout link (pay.html) you can redirect the end customer to.
curl -X POST localhost:5000/api/v1/payments/initialize \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"amount":5000,"customer":{"email":"jane@example.com","name":"Jane Doe"},"redirect_url":"https://example.com/thanks"}'

# Poll for status by tx_ref once the customer has paid
curl localhost:5000/api/v1/payments/verify/<tx_ref> \
  -H "Authorization: Bearer sk_test_xxx"
```

## API Endpoints

All routes below live under `/api/v1` (current, use this for new integrations)
and are also mounted unversioned at `/api` (back-compat alias only — see the
note in `app.js`; not a permanent second contract).

### Auth
- POST /api/v1/auth/register
- POST /api/v1/auth/login
- POST /api/v1/auth/logout
- POST /api/v1/auth/2fa/verify  (second step of login when 2FA is enabled — takes the short-lived `tempToken` from `/login`)
- POST /api/v1/auth/2fa/setup  (requires an authenticated session)
- POST /api/v1/auth/2fa/enable
- POST /api/v1/auth/2fa/disable

### Merchant
- GET   /api/v1/merchant/me
- PATCH /api/v1/merchant/webhook-url
- POST  /api/v1/merchant/regenerate-key

### Customers
- POST /api/v1/customers
- GET  /api/v1/customers

### Virtual Accounts
- POST /api/v1/virtual-accounts
- GET  /api/v1/virtual-accounts/:accountNumber
- POST /api/v1/virtual-accounts/:accountNumber/deactivate

### Checkout (public — no merchant API key; the customer never holds your secret key)
- GET  /pay/:checkoutToken  (serves the hosted `pay.html` page)
- GET  /api/v1/checkout/:token/status
- POST /api/v1/checkout/:token/simulate  (test-mode only — stands in for a real bank transfer; powers `pay.html`'s "simulate transfer" button)
- GET  /api/v1/checkout/:token/complete

### Payments (hosted checkout — server-to-server, requires merchant API key)
- POST /api/v1/payments/initialize
- GET  /api/v1/payments/verify/:tx_ref

### Wallet
- GET /api/v1/wallet
- GET /api/v1/wallet/all

### Transactions
- GET /api/v1/transactions

### Payouts
- POST /api/v1/payouts
- POST /api/v1/payouts/bulk
- GET  /api/v1/payouts

`idempotencyKey` (body field or `Idempotency-Key` header) is **required
in live mode** (optional in test mode) — see "Idempotency" below.

### Withdrawals
- POST /api/v1/withdrawals  (pays the merchant's own verified settlement
  account, unlike Payouts which pay an arbitrary recipient)
- GET  /api/v1/withdrawals
- GET  /api/v1/withdrawals/:id

Same `idempotencyKey` requirement as Payouts.

### Refunds
- POST /api/v1/refunds
- GET  /api/v1/refunds
- GET  /api/v1/refunds/:id

`idempotencyKey` required in live mode, same as Payouts.

### Subaccounts
- POST /api/v1/subaccounts
- GET  /api/v1/subaccounts
- GET  /api/v1/subaccounts/:id
- POST /api/v1/subaccounts/:id/settle

### Recipients
- POST   /api/v1/recipients
- GET    /api/v1/recipients
- GET    /api/v1/recipients/:id
- DELETE /api/v1/recipients/:id
- GET    /api/v1/banks
- POST   /api/v1/bank/accounts/resolve

### Subscriptions
- POST /api/v1/subscriptions/plans
- GET  /api/v1/subscriptions/plans
- POST /api/v1/subscriptions
- GET  /api/v1/subscriptions
- POST /api/v1/subscriptions/:id/cancel
- GET  /api/v1/subscriptions/invoices

### Disputes
- GET  /api/v1/disputes  (merchant-visible: own disputes only)
- GET  /api/v1/disputes/:id
- POST /api/v1/disputes/:id/evidence
- POST /api/v1/disputes  (ops-only, requires `INFRA_ADMIN_KEY` — a chargeback notice arriving from outside)
- POST /api/v1/disputes/:id/resolve  (ops-only, requires `INFRA_ADMIN_KEY`)

### Webhooks
- POST /api/v1/webhooks/bank  (bank-partner-only, HMAC signature required)
- POST /api/v1/webhooks/withdrawals  (bank-partner-only — RexxPay Bank
  confirming a withdrawal's final outcome; not documented elsewhere before
  now)

### Admin (operator-only)

Two layers of admin auth, not one:

- `INFRA_ADMIN_KEY` (`x-admin-key` header ONLY - there is no query-param
  form of this one, unlike the cron key below) — proves "this
  request comes from someone/something with server/ops access". Guards
  every route below.
- **Named admin sessions** (`POST /admin/auth/login`, then
  `Authorization: Bearer <token>`) — proves "and specifically, this
  named person". Required IN ADDITION to the key for the money-moving
  actions (resolving stuck payouts/withdrawals/refunds, releasing/
  rejecting flagged transactions), so those specific actions are tied to
  an accountable person, not just "whoever has the shared key". See
  `src/modules/admin/adminUser.model.js`. Bootstrap the first account
  with `node scripts/create-admin-user.js <email> <role>` (roles:
  `superadmin`, `finance`, `support` — `finance`/`superadmin` can
  resolve/release, `support` is currently read-only).

Routes:
- POST   /api/v1/admin/auth/login  (`x-admin-key` + email/password →
  admin session token, 12h expiry by default)
- GET    /api/v1/admin/stuck-payments  (`x-admin-key` header — visibility into any payout/withdrawal/refund sitting in `reserved`/`processing`/`ambiguous`)
- POST   /api/v1/admin/payouts/:reference/resolve  (**requires an admin session**, role `finance`/`superadmin` — manually confirm a stuck payout succeeded/failed after checking with the bank directly)
- POST   /api/v1/admin/withdrawals/:reference/resolve  (**requires an admin session**, same as above)
- POST   /api/v1/admin/refunds/:reference/resolve  (**requires an admin session**, same as above)
- POST   /api/v1/admin/transactions/:reference/resolve  (**requires an admin session** — release or reject an inbound transaction flagged by risk/velocity/sanctions checks; `{ "action": "release" | "reject" }`)
- GET    /api/v1/admin/provision-pool  (`?bankSlug=&count=`, `x-admin-key` header)
- GET    /api/v1/admin/pool-status  (`x-admin-key` header)
- PATCH  /api/v1/admin/merchants/:id/settlement-account/verify  (marks a merchant's settlement bank account as verified — separate from `isVerified` below)
- PATCH  /api/v1/admin/merchants/:id/fees  (per-merchant fee override; never merchant-settable)
- PATCH  /api/v1/admin/recipients/:id/verify  (**requires an admin session**, role `finance`/`superadmin` — manual fallback for verifying a payout Recipient's account name when automated provider resolution wasn't available at creation time; see `resolveBankAccount()`)
- GET    /api/v1/admin/webhook-events  (`?status=&source=&limit=` — browse inbound webhook events; `status=failed` is effectively the dead-letter queue, see `MAX_ATTEMPTS` in `webhook.processor.js`)
- POST   /api/v1/admin/webhook-events/:id/redrive  (**requires an admin session**, role `finance`/`superadmin` — manually retry a dead-lettered webhook event; distinct from the automatic `redriveStuckEvents()` that recovers events crashed mid-processing)
- GET    /api/v1/admin/audit-logs  (`?actorType=&action=&entityType=&entityRef=&severity=&limit=&before=`)
- GET    /api/v1/admin/merchants  (`?isVerified=&limit=` — excludes secret-key hashes and `passwordHash`, same exclusion a merchant's own profile view uses)
- POST   /api/v1/admin/settlement/run  (`?currency=&mode=`, forces a settlement cycle now for one mode — the scheduled trigger is `npm run run-settlement`, which runs both `live` and `test`)
- GET    /api/v1/admin/settlement/batches  (`?currency=&mode=&phase=&limit=`, inspect recent settlement batches)

Cron routes (guarded by `requireCronKey`, a **separate** key from
`INFRA_ADMIN_KEY` — see `CRON_TRIGGER_KEY` in `.env.example` and
"Cron" below for why):
- GET    /api/v1/admin/cron/release-stale-accounts  (`?cronKey=`; mirrors `scripts/release-stale-accounts.js`)
- GET    /api/v1/admin/cron/reactivate-expired-accounts  (`?cronKey=`; mirrors `scripts/reactivate-expired-accounts.js`)
- GET    /api/v1/admin/cron/auto-provision-pool  (`?cronKey=&threshold=&topUpCount=`; mirrors `scripts/auto-provision-pool.js`; locked so two overlapping runs can't double-provision — see `src/utils/cronLock.js`)
- GET    /api/v1/admin/cron/run-settlement  (`?cronKey=&currencies=NGN,USD`; mirrors `scripts/run-settlement.js`)
- GET    /api/v1/admin/cron/generate-invoices  (`?cronKey=`; mirrors `scripts/generate-invoices.js`)
- GET    /api/v1/admin/cron/fetch-and-reconcile  (`?cronKey=&from=&to=`; mirrors `scripts/fetch-and-reconcile.js` — pulls RexxPay Bank's confirmed-deposit export and reconciles it against our own transactions)
- GET    /api/v1/admin/cron/reconcile-outbound  (`?cronKey=&minutes=`; mirrors `scripts/reconcile-outbound.js` — checks with the bank directly on anything stuck `reserved`/`processing`/`ambiguous` for longer than `minutes`, default 30. Previously NOT wired to any cron route at all, meaning it only ever ran if someone remembered to run the script by hand.)
- GET    /api/v1/admin/cron/health  (`x-admin-key` header only — reports whether each scheduled cron job above has actually run recently)

### Demo (public — no signup, no API key)
- POST /api/v1/demo/checkout  (runs a full test-mode checkout — virtual account → simulated bank transfer → success — against one dedicated demo merchant; rate-limited, capped at `DEMO_MAX_AMOUNT_MINOR`)

## Author

Built by Rexxwurld
