// src/modules/bankPartner/bank.controller.js
const { listBanks, isKnownBankCode } = require('../../config/banks');
const { resolveBankAccount } = require('./bankPartner.service');
const auditLog = require('../audit/auditLog.service');

// GET /api/v1/banks
function getBanks(req, res) {
  res.json({ status: true, data: listBanks() });
}

// POST /api/v1/bank/accounts/resolve
// { "bank_code": "058", "account_number": "0123456789" }
//
// Returns the provider-verified account name where available. See
// bankPartner.service.js#resolveBankAccount for the important caveat:
// this depends on a RexxPay Bank endpoint whose real contract is
// unconfirmed. When resolution isn't available, this returns 502 rather
// than fabricating a name - callers must not treat a missing response as
// "any name is fine".
async function resolveAccount(req, res) {
  const bankCode = req.body?.bank_code || req.body?.bankCode;
  const accountNumber = req.body?.account_number || req.body?.accountNumber;

  if (!bankCode || !accountNumber) {
    return res.status(400).json({ status: false, message: 'bank_code_and_account_number_required' });
  }

  if (!isKnownBankCode(bankCode)) {
    return res.status(400).json({ status: false, message: 'unknown_bank_code' });
  }

  try {
    const result = await resolveBankAccount({ bankCode, accountNumber });
    return res.json({
      status: true,
      data: {
        account_number: result.accountNumber,
        account_name: result.accountName,
        bank_code: result.bankCode,
      },
    });
  } catch (err) {
    await auditLog.record({
      actorType: 'merchant',
      actorRef: req.merchant?.id || null,
      action: 'bank_account_resolution_failed',
      severity: 'warning',
      metadata: { bankCode, reason: err.reason || err.message },
    });

    return res.status(502).json({
      status: false,
      message: 'account_resolution_unavailable',
      detail: 'Could not verify this account with the bank right now. The account can still be saved, but will require manual verification before it can be paid out to.',
    });
  }
}

module.exports = { getBanks, resolveAccount };
