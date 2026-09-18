// src/modules/admin/adminAuth.service.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const AdminUser = require('./adminUser.model');
const auditLog = require('../audit/auditLog.service');
const { adminJwtSecret, adminJwtExpiresIn } = require('../../config/env');

async function loginAdmin({ email, password }) {
  const admin = await AdminUser.findOne({ email: (email || '').toLowerCase().trim() });

  // Same shape of error whether the email doesn't exist or the password
  // is wrong - don't let this endpoint be used to enumerate admin emails.
  if (!admin || !admin.active) throw new Error('invalid_admin_credentials');

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) throw new Error('invalid_admin_credentials');

  admin.lastLoginAt = new Date();
  await admin.save();

  const token = jwt.sign(
    { id: admin._id, role: admin.role, purpose: 'admin_session' },
    adminJwtSecret,
    { expiresIn: adminJwtExpiresIn }
  );

  await auditLog.record({
    actorType: 'admin',
    actorRef: admin._id.toString(),
    action: 'admin.login',
    entityType: 'AdminUser',
    entityRef: admin._id.toString(),
    severity: 'info',
  });

  return { token, admin: { id: admin._id, email: admin.email, role: admin.role } };
}

// Not exposed over HTTP on purpose - admin accounts are provisioned via
// scripts/create-admin-user.js (run by whoever holds server/DB access),
// never through a public or even authenticated-admin self-service
// endpoint. A self-service "create another admin" endpoint is itself a
// privilege-escalation surface.
async function createAdminUser({ email, password, role }) {
  if (!email || !password) throw new Error('email_and_password_required');
  if (!['superadmin', 'finance', 'support'].includes(role)) throw new Error('invalid_admin_role');
  if (password.length < 12) throw new Error('admin_password_too_short'); // higher bar than merchant passwords - this account can move money

  const passwordHash = await bcrypt.hash(password, 12);
  return AdminUser.create({ email: email.toLowerCase().trim(), passwordHash, role });
}

module.exports = { loginAdmin, createAdminUser };
