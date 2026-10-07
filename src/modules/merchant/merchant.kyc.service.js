// src/modules/merchant/merchant.kyc.service.js
//
// Business verification ("Go live"). A merchant starts in test/demo mode and
// submits business + owner details and documents; an admin reviews and
// approves or rejects. Approval is the ONLY thing that sets isVerified=true,
// which is the flag every live-mode gate already checks (live payment links,
// payouts, live key generation).
//
// Documents are stored privately (see utils/r2.js) under random keys and are
// never returned to the merchant after upload - only name/size/date.
const crypto = require('crypto');
const Merchant = require('./merchant.model');
const auditLog = require('../audit/auditLog.service');
const { detectFileType } = require('../../utils/fileType');
const r2 = require('../../utils/r2');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DOC_KINDS = ['id', 'proof_of_address', 'cac'];
const BUSINESS_TYPES = ['individual', 'sole_proprietor', 'registered_company'];
const ID_TYPES = ['nin', 'drivers_license', 'passport', 'voters_card'];
const EDITABLE = ['not_started', 'rejected'];

// Merchants verified by hand before KYC existed have isVerified=true and
// kyc.status 'not_started' - treat them as approved.
function effectiveStatus(m) {
  const s = (m.kyc && m.kyc.status) || 'not_started';
  return m.isVerified && s === 'not_started' ? 'approved' : s;
}

function safeName(name) {
  return String(name || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100);
}

function text(v, min, max, errCode) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < min || t.length > max) throw new Error(errCode);
  return t;
}

function toMerchantView(m) {
  const k = m.kyc || {};
  const status = effectiveStatus(m);
  return {
    status,
    canEdit: EDITABLE.includes(status),
    rejectionReason: status === 'rejected' ? k.rejectionReason || null : null,
    submittedAt: k.submittedAt || null,
    reviewedAt: k.reviewedAt || null,
    settlementAccountSet: !!(m.settlementAccount && m.settlementAccount.accountNumber),
    details: {
      businessType: k.businessType || '',
      legalName: k.legalName || '',
      address: k.address || '',
      website: k.website || '',
      businessDescription: k.businessDescription || '',
      ownerFullName: k.ownerFullName || '',
      idType: k.idType || '',
    },
    documents: (k.documents || []).map((d) => ({
      kind: d.kind,
      originalName: d.originalName,
      size: d.size,
      uploadedAt: d.uploadedAt,
    })),
  };
}

async function getKyc(merchantId) {
  const m = await Merchant.findById(merchantId);
  if (!m) throw new Error('merchant_not_found');
  return toMerchantView(m);
}

async function uploadDocument(merchantId, kind, file) {
  if (!DOC_KINDS.includes(kind)) throw new Error('invalid_document_kind');
  if (!file || !file.buffer || !file.buffer.length) throw new Error('file_required');
  if (file.size > MAX_FILE_BYTES) throw new Error('file_too_large');

  const type = detectFileType(file.buffer);
  if (!type) throw new Error('unsupported_file_type');

  const m = await Merchant.findById(merchantId);
  if (!m) throw new Error('merchant_not_found');
  if (!EDITABLE.includes(effectiveStatus(m))) throw new Error('kyc_not_editable');

  const key = `kyc/${merchantId}/${kind}-${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
  await r2.putPrivateObject({ key, body: file.buffer, contentType: type.mime });

  const existing = m.kyc.documents || [];
  const previous = existing.find((d) => d.kind === kind);
  m.kyc.documents = existing.filter((d) => d.kind !== kind);
  m.kyc.documents.push({
    kind,
    key,
    originalName: safeName(file.originalname),
    contentType: type.mime,
    size: file.size,
    uploadedAt: new Date(),
  });
  await m.save();

  if (previous) r2.deleteObject(previous.key).catch(() => {}); // best-effort cleanup of the replaced file

  return { kind, originalName: safeName(file.originalname), size: file.size };
}

async function submitKyc(merchantId, input = {}) {
  const m = await Merchant.findById(merchantId);
  if (!m) throw new Error('merchant_not_found');
  if (!EDITABLE.includes(effectiveStatus(m))) throw new Error('kyc_not_editable');

  const businessType = input.businessType;
  if (!BUSINESS_TYPES.includes(businessType)) throw new Error('business_type_invalid');
  const idType = input.idType;
  if (!ID_TYPES.includes(idType)) throw new Error('id_type_invalid');

  const legalName = text(input.legalName, 2, 120, 'legal_name_invalid');
  const address = text(input.address, 5, 300, 'address_invalid');
  const ownerFullName = text(input.ownerFullName, 2, 120, 'owner_name_invalid');
  const businessDescription = text(input.businessDescription, 10, 500, 'business_description_too_short');

  let website = '';
  if (input.website && String(input.website).trim()) {
    website = String(input.website).trim().slice(0, 200);
    let u;
    try { u = new URL(website); } catch { throw new Error('website_invalid'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('website_invalid');
  }

  const kinds = (m.kyc.documents || []).map((d) => d.kind);
  if (!kinds.includes('id')) throw new Error('id_document_required');
  if (businessType === 'registered_company' && !kinds.includes('cac')) throw new Error('cac_document_required');
  if (!(m.settlementAccount && m.settlementAccount.accountNumber)) throw new Error('add_a_settlement_account_first');

  m.kyc.businessType = businessType;
  m.kyc.legalName = legalName;
  m.kyc.address = address;
  m.kyc.website = website;
  m.kyc.businessDescription = businessDescription;
  m.kyc.ownerFullName = ownerFullName;
  m.kyc.idType = idType;
  m.kyc.status = 'pending';
  m.kyc.submittedAt = new Date();
  m.kyc.rejectionReason = null;
  await m.save();

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'merchant.kyc_submitted',
    entityType: 'Merchant',
    entityRef: merchantId.toString(),
    severity: 'info',
  });

  return toMerchantView(m);
}

/* ---------------- admin side ---------------- */

async function listKycSubmissions(status = 'pending', limit = 50) {
  if (!['pending', 'approved', 'rejected'].includes(status)) throw new Error('invalid_status');
  const rows = await Merchant.find({ 'kyc.status': status })
    .select('businessName email plan kyc.status kyc.businessType kyc.legalName kyc.ownerFullName kyc.submittedAt kyc.reviewedAt')
    .sort({ 'kyc.submittedAt': 1 })
    .limit(Math.min(Number(limit) || 50, 200));

  return rows.map((m) => ({
    merchantId: m._id,
    businessName: m.businessName,
    email: m.email,
    plan: m.plan,
    status: m.kyc.status,
    businessType: m.kyc.businessType,
    legalName: m.kyc.legalName,
    ownerFullName: m.kyc.ownerFullName,
    submittedAt: m.kyc.submittedAt,
    reviewedAt: m.kyc.reviewedAt,
  }));
}

async function getKycForReview(merchantId, adminUser) {
  const m = await Merchant.findById(merchantId).select('businessName email plan isVerified settlementAccount kyc');
  if (!m) throw new Error('merchant_not_found');
  const k = m.kyc || {};

  const documents = await Promise.all(
    (k.documents || []).map(async (d) => ({
      kind: d.kind,
      originalName: d.originalName,
      contentType: d.contentType,
      size: d.size,
      uploadedAt: d.uploadedAt,
      url: await r2.signedGetUrl(d.key, { expiresIn: 300, filename: d.originalName }),
    }))
  );

  await auditLog.record({
    actorType: 'admin',
    actorRef: adminUser.id,
    action: 'admin.kyc_documents_viewed',
    entityType: 'Merchant',
    entityRef: m._id.toString(),
    severity: 'info',
  });

  const acct = m.settlementAccount || {};
  return {
    merchantId: m._id,
    businessName: m.businessName,
    email: m.email,
    plan: m.plan,
    isVerified: m.isVerified,
    settlementAccount: {
      bankCode: acct.bankCode || null,
      accountName: acct.accountName || null,
      accountNumberLast4: acct.accountNumber ? String(acct.accountNumber).slice(-4) : null,
    },
    kyc: {
      status: k.status,
      businessType: k.businessType,
      legalName: k.legalName,
      address: k.address,
      website: k.website,
      businessDescription: k.businessDescription,
      ownerFullName: k.ownerFullName,
      idType: k.idType,
      submittedAt: k.submittedAt,
      reviewedAt: k.reviewedAt,
      rejectionReason: k.rejectionReason,
    },
    documents,
  };
}

async function approveKyc(merchantId, adminUser) {
  // Conditional update: only a still-pending submission can be approved, so
  // two admins clicking at once can't double-process.
  const m = await Merchant.findOneAndUpdate(
    { _id: merchantId, 'kyc.status': 'pending' },
    {
      $set: {
        'kyc.status': 'approved',
        'kyc.reviewedAt': new Date(),
        'kyc.reviewedBy': adminUser.id,
        'kyc.rejectionReason': null,
        isVerified: true,
      },
    },
    { new: true }
  );
  if (!m) throw new Error('kyc_not_pending');

  await auditLog.record({
    actorType: 'admin',
    actorRef: adminUser.id,
    action: 'admin.kyc_approved',
    entityType: 'Merchant',
    entityRef: m._id.toString(),
    severity: 'warning',
  });
  return { merchantId: m._id, status: 'approved' };
}

async function rejectKyc(merchantId, reason, adminUser) {
  const why = text(reason, 5, 300, 'rejection_reason_required');
  // Also allowed on an approved merchant - that is how an admin revokes live access.
  const m = await Merchant.findOneAndUpdate(
    { _id: merchantId, 'kyc.status': { $in: ['pending', 'approved'] } },
    {
      $set: {
        'kyc.status': 'rejected',
        'kyc.reviewedAt': new Date(),
        'kyc.reviewedBy': adminUser.id,
        'kyc.rejectionReason': why,
        isVerified: false,
      },
    },
    { new: true }
  );
  if (!m) throw new Error('kyc_not_reviewable');

  await auditLog.record({
    actorType: 'admin',
    actorRef: adminUser.id,
    action: 'admin.kyc_rejected',
    entityType: 'Merchant',
    entityRef: m._id.toString(),
    severity: 'warning',
  });
  return { merchantId: m._id, status: 'rejected' };
}

module.exports = {
  getKyc, uploadDocument, submitKyc,
  listKycSubmissions, getKycForReview, approveKyc, rejectKyc,
};
