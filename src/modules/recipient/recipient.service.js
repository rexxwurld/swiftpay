// src/modules/recipient/recipient.service.js
const { nanoid } = require('nanoid');
const Recipient = require('./recipient.model');
const { isKnownBankCode } = require('../../config/banks');
const { resolveBankAccount } = require('../bankPartner/bankPartner.service');
const auditLog = require('../audit/auditLog.service');

// Never trusts the merchant-supplied accountName as-is (see requirement:
// "do not trust a merchant-supplied account name"). Attempts provider
// resolution first; the provider's own returned name always wins over
// whatever the merchant typed. If resolution isn't available right now
// (see bankPartner.service.js#resolveBankAccount for why that can
// happen), the recipient is still created - so a merchant isn't blocked
// mid-payroll-setup by a provider outage - but stays `verified: false`
// and payout.service.js refuses to pay out to it until an operator
// verifies it by hand (PATCH /api/admin/recipients/:id/verify) or a
// later resolution attempt succeeds.
async function createRecipient({ merchantId, label, bankCode, accountNumber, accountName }) {
  if (!label || !bankCode || !accountNumber || !accountName) {
    throw new Error('missing_required_fields');
  }

  if (!isKnownBankCode(bankCode)) {
    throw new Error('unknown_bank_code');
  }

  let finalAccountName = accountName;
  let verified = false;
  let verifiedAt = null;
  let verificationMethod = null;

  try {
    const resolved = await resolveBankAccount({ bankCode, accountNumber });
    finalAccountName = resolved.accountName; // provider's name, not the merchant's input
    verified = true;
    verifiedAt = new Date();
    verificationMethod = 'provider';
  } catch (err) {
    await auditLog.record({
      actorType: 'merchant',
      actorRef: merchantId,
      action: 'recipient.created_unverified',
      severity: 'warning',
      metadata: { bankCode, reason: err.reason || err.message },
    });
  }

  return Recipient.create({
    merchant: merchantId,
    recipientCode: `rcp_${nanoid(16)}`,
    label,
    bankCode,
    accountNumber,
    accountName: finalAccountName,
    verified,
    verifiedAt,
    verificationMethod,
  });
}

async function listForMerchant(merchantId) {
  return Recipient.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, recipientId) {
  const recipient = await Recipient.findOne({ _id: recipientId, merchant: merchantId });
  if (!recipient) throw new Error('recipient_not_found');
  return recipient;
}

async function findActiveByCodeForMerchant(merchantId, recipientCode) {
  return Recipient.findOne({ recipientCode, merchant: merchantId, active: true });
}

// Soft delete - payouts already made keep their own snapshot of the bank
// details, so deactivating never affects payout history, only future use.
async function deactivateRecipient(merchantId, recipientId) {
  const recipient = await getForMerchant(merchantId, recipientId);
  recipient.active = false;
  await recipient.save();
  return recipient;
}

module.exports = {
  createRecipient,
  listForMerchant,
  getForMerchant,
  findActiveByCodeForMerchant,
  deactivateRecipient,
};
