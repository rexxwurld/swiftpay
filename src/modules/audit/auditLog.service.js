// src/modules/audit/auditLog.service.js
const AuditLog = require('./auditLog.model');

// Field names that commonly carry PII/secrets, redacted from `metadata`
// no matter which call site put them there. This is defense-in-depth,
// not a substitute for call sites being careful in the first place - the
// audit model's own comment says "never store secrets/PII here", but
// `metadata` is a Mixed field with no schema enforcement, so a future
// call site can (and one already did - see payout.service.js) drop a raw
// account number in without anything catching it (see audit report,
// Medium #25).
const SENSITIVE_KEY_PATTERN = /accountnumber|cardnumber|cvv|\bpin\b|password|secret|token|apikey|api_key/i;

function redactMetadata(value, depth = 0) {
  if (value == null || depth > 4) return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactMetadata(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = maskValue(val);
      } else {
        out[key] = redactMetadata(val, depth + 1);
      }
    }
    return out;
  }

  return value;
}

function maskValue(val) {
  if (typeof val !== 'string' && typeof val !== 'number') return '[redacted]';
  const str = String(val);
  if (str.length <= 4) return '[redacted]';
  return `***${str.slice(-4)}`; // last 4 digits only - enough to cross-reference, not enough to be useful on its own
}

// Fire-and-forget by design: a failure to WRITE an audit log must never
// block or fail the underlying business operation. Log the failure to
// stderr instead so an ops alert can catch it.
async function record({ actorType, actorRef, action, entityType, entityRef, ip, metadata, severity }) {
  try {
    await AuditLog.create({
      actorType,
      actorRef,
      action,
      entityType,
      entityRef,
      ip,
      metadata: redactMetadata(metadata),
      severity,
    });
  } catch (err) {
    console.error('[audit] failed to write audit log:', err.message, { action });
  }
}

// Read-only browsing for ops (see admin.routes.js's GET /admin/audit-logs) -
// req. #24 ("Build an operational dashboard/API for ... audit logs"). Never
// used by the write path above; `record()` stays fire-and-forget and
// unaffected by this.
async function list({ actorType, action, entityType, entityRef, severity, limit = 50, before } = {}) {
  const query = {};
  if (actorType) query.actorType = actorType;
  if (action) query.action = action;
  if (entityType) query.entityType = entityType;
  if (entityRef) query.entityRef = entityRef;
  if (severity) query.severity = severity;
  if (before) query.createdAt = { $lt: new Date(before) };

  return AuditLog.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200));
}

module.exports = { record, list };
