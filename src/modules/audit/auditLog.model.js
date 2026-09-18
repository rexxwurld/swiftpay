// src/modules/audit/auditLog.model.js
//
// An append-only trail of security-relevant and money-relevant events.
// Regulators, dispute resolution, and incident response all eventually
// need "who did what, when, from where" - and it has to exist BEFORE the
// incident, not be reconstructed after from scattered console.logs.

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actorType: { type: String, enum: ['merchant', 'system', 'bank_partner', 'admin'], required: true },
    actorRef: { type: String }, // merchant id, "webhook", "reconciliation_job", etc.

    action: { type: String, required: true }, // e.g. "merchant.login", "webhook.signature_invalid", "payout.created"
    entityType: { type: String }, // e.g. "Transaction", "Payout", "Merchant"
    entityRef: { type: String },

    ip: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed }, // small, non-sensitive context only - never store secrets/PII here

    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
  },
  { timestamps: true }
);

auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityRef: 1 });

// ============================================================
// APPEND-ONLY ENFORCEMENT
// ============================================================
// Previously "append-only" was a comment, not something enforced -
// nothing stopped `AuditLog.updateOne(...)` or `.deleteOne(...)` from
// being called (see audit report, Medium #24). These hooks make the
// common Mongoose write paths refuse to touch an existing document.
//
// HONEST LIMITATION: this is applied at the Mongoose layer, not the
// database layer - it stops accidental or malicious use of THIS
// application's model, not someone with direct database credentials
// using the raw MongoDB driver, `mongosh`, or a backup/restore tool.
// Real tamper-resistance for a regulated financial audit trail needs
// one or more of: a DB user for this app that only has insert
// privilege on this collection (enforced by MongoDB itself, not by
// application code), shipping events to a separate WORM/append-only
// store, or object-lock storage for periodic exports. This is a
// meaningful floor, not the full answer.
function blockMutation(methodName) {
  return function blockedMutationHook(next) {
    next(new Error(`AuditLog is append-only - ${methodName}() is not permitted`));
  };
}

['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'].forEach((method) => {
  auditLogSchema.pre(method, blockMutation(method));
});

['deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove'].forEach((method) => {
  auditLogSchema.pre(method, blockMutation(method));
});

// Covers `doc.remove()` / `doc.deleteOne()` called on an already-loaded
// document instance, which use the 'deleteOne' document middleware hook
// (distinct from the query middleware hooks above).
auditLogSchema.pre('deleteOne', { document: true, query: false }, blockMutation('document.deleteOne'));

// Covers `doc.save()` being used to mutate an EXISTING record (a `save()`
// on a brand-new document, i.e. AuditLog.create()/new AuditLog().save(),
// is still allowed - that's the only way these documents get written).
auditLogSchema.pre('save', function blockExistingDocumentMutation(next) {
  if (!this.isNew) {
    return next(new Error('AuditLog is append-only - modifying an existing record is not permitted'));
  }
  return next();
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
