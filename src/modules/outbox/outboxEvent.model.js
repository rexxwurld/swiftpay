// src/modules/outbox/outboxEvent.model.js
//
// The actual transactional-outbox pattern (previously missing entirely -
// see audit report, item 8): rather than committing a financial
// transaction and then separately, outside that transaction, trying to
// run side effects (account deactivation, merchant webhook, invoice
// reconciliation), the side effects are enqueued as OutboxEvent documents
// INSIDE THE SAME DB TRANSACTION as the financial commit (see
// transaction.service.js's recordIncomingPayment). If the transaction
// commits, the outbox events exist - guaranteed, atomically, by MongoDB
// itself. If it doesn't commit, neither do they. There is no window
// where "the money was recorded but nothing knows it needs to notify
// anyone" - the earlier `postPaymentEffectsAt` flag approach caught the
// PREVIOUSLY-IDENTIFIED failure window, but manually re-deriving "what
// still needs to happen" from application state is a narrower, more
// fragile guarantee than durable work items created in the same commit.
//
// A separate, independent process (src/queue/outboxWorker.js) polls for
// pending events and dispatches them - fully decoupled from the original
// request/webhook-processing path, so it keeps making progress even if
// that path is down, and its own crashes just leave events `pending` or
// reclaimable from a stale `processing` lease (see outbox.service.js's
// redriveStuckProcessing).

const mongoose = require('mongoose');

const outboxEventSchema = new mongoose.Schema({
  eventType: {
    type: String,
    enum: ['deactivate_virtual_account', 'dispatch_merchant_webhook', 'mark_invoice_paid'],
    required: true,
  },

  // What financial/business event this outbox entry exists because of -
  // purely for tracing/debugging, not used for dedup logic (the unique
  // index below handles that).
  sourceType: { type: String, required: true },
  sourceRef: { type: String, required: true },

  payload: { type: mongoose.Schema.Types.Mixed, required: true },

  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
    index: true,
  },

  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 10 },
  lastError: { type: String, default: null },

  // Events aren't eligible to be claimed until this time - used both for
  // "not yet due" (initial value) and for backoff after a failed
  // attempt, so a permanently-broken merchant webhook URL doesn't get
  // hammered in a tight retry loop.
  availableAt: { type: Date, required: true, default: Date.now, index: true },

  claimedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

// One event of a given type per source event - defense-in-depth against
// double-enqueueing (the real guarantee is that enqueueing happens
// inside the same Mongo transaction as the source event's own creation,
// so a transaction rollback rolls these back too; this index just makes
// sure nothing can violate that intent even via a bug elsewhere).
outboxEventSchema.index({ eventType: 1, sourceType: 1, sourceRef: 1 }, { unique: true });

outboxEventSchema.index({ status: 1, availableAt: 1 });

module.exports = mongoose.model('OutboxEvent', outboxEventSchema);
