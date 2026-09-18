// src/modules/admin/adminUser.model.js
//
// Everything under /api/admin used to be gated by ONE shared secret
// (x-admin-key / INFRA_ADMIN_KEY) with no concept of who actually
// performed an action - anyone holding the key can do anything, and the
// audit trail can only ever say "the admin key was used", never which
// human used it (see audit report, "Admin" section under Security
// Verdict, and item 24 in the repair plan).
//
// This introduces named, role-scoped admin accounts for the most
// sensitive actions (manually resolving a stuck payout/withdrawal/
// refund, or releasing/rejecting a flagged inbound transaction) so those
// specific actions require BOTH the infra key (proves "this request came
// from someone with server/ops access") AND a real admin login (proves
// "and specifically, this named person"). The infra key alone still
// gates cron endpoints and lower-stakes read/ops routes - this is
// additive, not a full replacement of every admin route, which would be
// a much larger change than this repo's admin surface currently needs.

const mongoose = require('mongoose');

const adminUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },

    // 'superadmin' can do anything an admin route allows.
    // 'finance' can resolve stuck payouts/withdrawals/refunds and
    //   release/reject flagged transactions - the money-moving actions.
    // 'support' is read-only for now (reserved for future read-only
    //   admin routes, e.g. viewing stuck payments without resolving them).
    role: { type: String, enum: ['superadmin', 'finance', 'support'], required: true },

    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminUser', adminUserSchema);
