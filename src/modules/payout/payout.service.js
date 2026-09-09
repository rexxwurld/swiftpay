// src/modules/payout/payout.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const Payout = require('./payout.model');
const { reserveFunds, finalizeReservedDebit, releaseReservedFunds, getOrCreateWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { findActiveByCodeForMerchant } = require('../recipient/recipient.service');
const { dispatchMerchantWebhook } = require('../../utils/merchantWebhook');   
const { sendPayoutInstruction, simulatePayoutInstruction } = require('../bankPartner/rexxPayBankClient');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');
const Merchant = require('../merchant/merchant.model');

const MAX_BULK_PAYOUT_ITEMS = 100;

function toMajorUnits(amountMinorUnits) {
  return amountMinorUnits / 100;
}

async function requestPayout({
  merchantId,
  amount,
  currency = 'NGN',
  idempotencyKey = null,
  recipientCode,
  destinationBankCode,
  destinationAccountNumber,
  destinationAccountName,
  mode,
}) {
  // Deliberately no default. A payout MUST know whether it's real money
  // or not - this is the exact ambiguity that let a leaked test key
  // trigger a real bank transfer before this change.
  if (mode !== 'test' && mode !== 'live') {
    throw new Error('payout_mode_required');
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('invalid_payout_amount');
  }

  const merchant = await Merchant.findById(merchantId);
  const merchantLimits = limits.getLimitsForMerchant(merchant);

  if (amount > merchantLimits.MAX_SINGLE_PAYOUT_MINOR) {
    throw new Error('payout_exceeds_max_single_payout_limit');
  }

  if (idempotencyKey) {
    const existing = await Payout.findOne({ merchant: merchantId, idempotencyKey, mode });
    if (existing) {
      return existing;
    }
  }

  if (recipientCode) {
    const recipient = await findActiveByCodeForMerchant(merchantId, recipientCode);
    if (!recipient) throw new Error('unknown_or_inactive_recipient');
    destinationBankCode = recipient.bankCode;
    destinationAccountNumber = recipient.accountNumber;
    destinationAccountName = recipient.accountName;
  }

  if (!destinationBankCode || !destinationAccountNumber || !destinationAccountName) {
    throw new Error('destination_account_required');
  }

  const reference = `po_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let payout;
  try {
    session.startTransaction();

    const wallet = await reserveFunds(merchantId, amount, session, currency, mode);

    const [created] = await Payout.create(
      [
        {
          merchant: merchantId,
          reference,
          idempotencyKey,
          amount,
          currency,
          mode,
          destinationBankCode,
          destinationAccountNumber,
          destinationAccountName,
          status: 'reserved',
        },
      ],
      { session, ordered: true }
    );
    payout = created;

    await postDoubleEntry({
      entryGroup: `payout_${payout._id}`,
      amount,
      currency,
      sourceType: 'payout',
      sourceRef: payout._id.toString(),
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Payout requested - funds reserved' },
      credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Funds moved to payout clearing pending bank confirmation' },
      session,
    });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    if (err.code === 11000 && idempotencyKey) {
      const raced = await Payout.findOne({ merchant: merchantId, idempotencyKey, mode });
      if (raced) return raced;
    }
    throw err;
  }

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'payout.requested',
    entityType: 'Payout',
    entityRef: payout._id.toString(),
    metadata: { amount, destinationAccountNumber, mode },
  });

  payout.status = 'processing';
  await payout.save();

  try {
    // THE gate: live payouts call the real bank, test payouts never do.
    const bankCall = mode === 'live' ? sendPayoutInstruction : simulatePayoutInstruction;

    const result = await bankCall({
      idempotencyKey: payout.reference,
      amountMajorUnits: toMajorUnits(amount),
      destinationAccountNumber,
      destinationBank: destinationBankCode,
      destinationAccountName,
    });

    if (result.success) {
      await finalizePayoutSuccess(payout, result.payout?.providerReference || null);
    } else {
      await reversePayout(payout, result.payout?.failureReason || 'bank_declined');
    }
  } catch (err) {
    if (err.ambiguousOutcome) {
      payout.status = 'ambiguous';
      payout.failureReason = `bank_call_ambiguous: ${err.message}`;
      await payout.save();

      await auditLog.record({
        actorType: 'system',
        actorRef: 'payout_service',
        action: 'payout.ambiguous_outcome',
        entityType: 'Payout',
        entityRef: payout._id.toString(),
        severity: 'critical',
        metadata: { error: err.message },
      });
    } else {
      await reversePayout(payout, err.message);
    }
  }

  return payout;
}

async function finalizePayoutSuccess(payout, providerReference) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const wallet = await getOrCreateWallet(payout.merchant, payout.currency, payout.mode, session);
    await finalizeReservedDebit(wallet._id, payout.amount, session);

    payout.status = 'successful';
    payout.providerRef = providerReference;
    await payout.save({ session });

    await session.commitTransaction();
    session.endSession();

    await auditLog.record({
      actorType: 'system',
      actorRef: 'payout_service',
      action: 'payout.successful',
      entityType: 'Payout',
      entityRef: payout._id.toString(),
      metadata: { amount: payout.amount, providerReference, mode: payout.mode },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function reversePayout(payout, reason) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const wallet = await getOrCreateWallet(payout.merchant, payout.currency, payout.mode, session);
    await releaseReservedFunds(wallet._id, payout.amount, session);

    await postDoubleEntry({
      entryGroup: `payout_reversal_${payout._id}`,
      amount: payout.amount,
      currency: payout.currency,
      sourceType: 'reversal',
      sourceRef: payout._id.toString(),
      debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Payout reversal' },
      credit: { accountType: 'merchant_wallet', accountRef: payout.merchant.toString(), description: 'Payout reversal - funds returned' },
      session,
    });
    payout.status = 'failed';
    payout.failureReason = reason;
    await payout.save({ session });
    await session.commitTransaction();
    session.endSession();

    await auditLog.record({
      actorType: 'system',
      actorRef: 'payout_service',
      action: 'payout.reversed',
      entityType: 'Payout',
      entityRef: payout._id.toString(),
      severity: 'warning',
      metadata: { reason, mode: payout.mode },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function listForMerchant(merchantId, mode = null) {
  const query = { merchant: merchantId };
  if (mode) query.mode = mode;
  return Payout.find(query).sort({ createdAt: -1 });
}

async function requestBulkPayout({ merchantId, currency = 'NGN', items, mode }) {
  if (mode !== 'test' && mode !== 'live') {
    throw new Error('payout_mode_required');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items_required');
  }
  if (items.length > MAX_BULK_PAYOUT_ITEMS) {
    throw new Error(`bulk_payout_exceeds_max_items:${MAX_BULK_PAYOUT_ITEMS}`);
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const payout = await requestPayout({
        merchantId,
        amount: item.amount,
        currency: item.currency || currency,
        idempotencyKey: item.idempotencyKey || null,
        recipientCode: item.recipientCode,
        destinationBankCode: item.destinationBankCode,
        destinationAccountNumber: item.destinationAccountNumber,
        destinationAccountName: item.destinationAccountName,
        mode,
      });
      results.push({ index: i, success: true, payout });
    } catch (err) {
      results.push({ index: i, success: false, error: err.message });
    }
  }

  const successCount = results.filter((r) => r.success).length;

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'payout.bulk_requested',
    entityType: 'Payout',
    entityRef: `bulk_${Date.now()}`,
    metadata: { totalItems: items.length, successCount, failureCount: items.length - successCount, mode },
  });

  return { results, successCount, failureCount: items.length - successCount };
}

module.exports = { requestPayout, requestBulkPayout, listForMerchant };
