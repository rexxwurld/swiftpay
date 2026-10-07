// src/modules/merchant/merchant.controller.js
const { getProfile, updateWebhookUrl, regenerateSecretKey, regenerateWebhookSecret, setSettlementAccount } = require('./merchant.service');
const kycService = require('./merchant.kyc.service');

async function profile(req, res) {
  const merchant = await getProfile(req.merchant.id);
  res.json({ status: true, data: merchant });
}

async function updateWebhook(req, res) {
  try {
    const { webhookUrl } = req.body;
    const merchant = await updateWebhookUrl(req.merchant.id, webhookUrl);
    res.json({ status: true, data: merchant });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function regenerateKey(req, res) {
  try {
    const { mode } = req.body;
    const result = await regenerateSecretKey(req.merchant.id, mode);
    res.json({
      status: true,
      message: `New ${mode} secret key generated. Store it now - it will not be shown again. Your old ${mode} key no longer works.`,
      data: result,
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function regenerateWebhook(req, res) {
  try {
    const result = await regenerateWebhookSecret(req.merchant.id);
    res.json({
      status: true,
      message: 'New webhook secret generated. Store it now - it will not be shown again. Any webhook already in flight will fail signature verification until you update your receiving app with this value.',
      data: result,
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function updateSettlementAccount(req, res) {
  try {
    const merchant = await setSettlementAccount(req.merchant.id, req.body);
    res.json({ status: true, message: 'Settlement account saved and is awaiting verification.', data: merchant });
  } catch (err) { res.status(400).json({ status: false, message: err.message }); }
}

// KYC is dashboard-only: an API key must never be able to submit or alter
// its own merchant's verification.
function sessionOnly(req, res, next) {
  if (req.merchant.mode) {
    return res.status(403).json({ status: false, message: 'dashboard_session_required' });
  }
  next();
}

// Errors the merchant can safely be shown. Anything else (storage/SDK
// internals) is logged and replaced with a generic message.
const KYC_USER_ERRORS = new Set([
  'invalid_document_kind', 'file_required', 'file_too_large', 'unsupported_file_type', 'kyc_not_editable',
  'business_type_invalid', 'id_type_invalid', 'legal_name_invalid', 'address_invalid', 'owner_name_invalid',
  'business_description_too_short', 'website_invalid', 'id_document_required', 'cac_document_required',
  'add_a_settlement_account_first', 'merchant_not_found',
]);

function kycError(res, err) {
  if (err.message === 'storage_not_configured') {
    return res.status(503).json({ status: false, message: 'document_storage_unavailable' });
  }
  if (KYC_USER_ERRORS.has(err.message)) {
    return res.status(400).json({ status: false, message: err.message });
  }
  console.error('kyc error:', err);
  return res.status(500).json({ status: false, message: 'something_went_wrong' });
}

async function kycStatus(req, res) {
  try {
    res.json({ status: true, data: await kycService.getKyc(req.merchant.id) });
  } catch (err) { kycError(res, err); }
}

async function kycUpload(req, res) {
  try {
    const data = await kycService.uploadDocument(req.merchant.id, req.query.kind, req.file);
    res.json({ status: true, data });
  } catch (err) { kycError(res, err); }
}

async function kycSubmit(req, res) {
  try {
    res.json({ status: true, data: await kycService.submitKyc(req.merchant.id, req.body) });
  } catch (err) { kycError(res, err); }
}

module.exports = {
  sessionOnly, kycStatus, kycUpload, kycSubmit, profile, updateWebhook, regenerateKey, regenerateWebhook, updateSettlementAccount };

