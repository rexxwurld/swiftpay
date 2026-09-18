// src/modules/outbox/outbox.service.js
const OutboxEvent = require('./outboxEvent.model');

/**
 * Enqueues one outbox event. MUST be called with `session` set to the
 * same Mongo session/transaction as the financial write it's attached
 * to - that's the entire guarantee this pattern provides. Enqueueing
 * outside a transaction (or in a different one) defeats the purpose.
 */
async function enqueue({ eventType, sourceType, sourceRef, payload, session }) {
  if (!session) {
    // Fail loudly rather than silently creating a non-atomic outbox
    // entry - a caller forgetting to pass the session is exactly the
    // bug this pattern exists to prevent.
    throw new Error('outbox_enqueue_requires_session');
  }

  const [event] = await OutboxEvent.create(
    [{ eventType, sourceType, sourceRef, payload, status: 'pending', availableAt: new Date() }],
    { session, ordered: true }
  );
  return event;
}

/**
 * Atomically claims up to `limit` due events, marking each `processing`
 * as it's claimed. Safe to call concurrently from multiple worker
 * processes - each underlying findOneAndUpdate only matches a
 * still-`pending` document, so two workers can never claim the same
 * event.
 */
async function claimBatch(limit = 20) {
  const now = new Date();
  const claimed = [];

  for (let i = 0; i < limit; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const event = await OutboxEvent.findOneAndUpdate(
      { status: 'pending', availableAt: { $lte: now } },
      { $set: { status: 'processing', claimedAt: now }, $inc: { attempts: 1 } },
      { sort: { availableAt: 1 }, new: true }
    );
    if (!event) break; // nothing left due right now
    claimed.push(event);
  }

  return claimed;
}

async function markCompleted(eventId) {
  await OutboxEvent.findByIdAndUpdate(eventId, {
    status: 'completed',
    completedAt: new Date(),
  });
}

/**
 * On failure: retry with exponential backoff (capped) until maxAttempts,
 * then permanently mark `failed` - at which point it needs a human (see
 * the critical audit log the worker writes alongside this) rather than
 * more automatic retries, since something is durably broken (bad
 * webhook URL, deleted account, etc), not transiently.
 */
async function markFailed(event, err) {
  if (event.attempts >= event.maxAttempts) {
    await OutboxEvent.findByIdAndUpdate(event._id, {
      status: 'failed',
      lastError: err.message,
    });
    return { permanentlyFailed: true };
  }

  const backoffMs = Math.min(5 * 60 * 1000, 1000 * 2 ** event.attempts); // caps at 5 minutes
  await OutboxEvent.findByIdAndUpdate(event._id, {
    status: 'pending',
    lastError: err.message,
    availableAt: new Date(Date.now() + backoffMs),
  });
  return { permanentlyFailed: false };
}

/**
 * Recovers events left `processing` by a worker that crashed mid-attempt
 * (the attempt was already counted in claimBatch, so this doesn't reset
 * the retry count - it just makes the event claimable again).
 */
async function redriveStuckProcessing(staleAfterMs = 5 * 60 * 1000) {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const result = await OutboxEvent.updateMany(
    { status: 'processing', claimedAt: { $lte: cutoff } },
    { $set: { status: 'pending', availableAt: new Date() } }
  );
  return result.modifiedCount || 0;
}

module.exports = { enqueue, claimBatch, markCompleted, markFailed, redriveStuckProcessing };
