// src/modules/payout/payout.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const Payout = require('./payout.model');
const DailyOutboundLimitCounter = require('./dailyOutboundLimitCounter.model');
const { reserveFundsWithLedgerEntry, finalizeReservedDebit, releaseReservedFunds, getOrCreateWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { findActiveByCodeForMerchant } = require('../recipient/recipient.service');
const { resolveBankAccount } = require('../bankPartner/bankPartner.service');
const { dispatchMerchantWebhook } = require('../../utils/merchantWebhook');
const { sendPayoutInstruction, simulatePayoutInstruction } = require('../bankPartner/rexxPayBankClient');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');
const Merchant = require('../merchant/merchant.model');
const { computeRequestFingerprint, assertFingerprintMatches } = require('../../utils/requestFingerprint');

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
  if (mode !== 'test' && mode !== 'live') {
    throw new Error('payout_mode_required');
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('invalid_payout_amount');
  }

  // A retry-safe payout MUST be retry-safe by construction: without a
  // mandatory idempotency key on live money movement, a client timeout
  // followed by a blind retry can create a second real payout (see audit
  // report, High #18). Test mode stays optional so local development and
  // quick manual testing aren't blocked by this.
  if (mode === 'live' && !idempotencyKey) {
    throw new Error('idempotency_key_required_for_live_payouts');
  }

  const merchant = await Merchant.findById(merchantId);
  const merchantLimits = limits.getLimitsForMerchant(merchant);

  if (amount > merchantLimits.MAX_SINGLE_PAYOUT_MINOR) {
    throw new Error('payout_exceeds_max_single_payout_limit');
  }

  // Was this destination provider-verified (a Recipient created via
  // resolveBankAccount(), or admin-verified where the provider lookup
  // wasn't available) - or a raw ad hoc destination this call is about
  // to send real money to sight-unseen? Tracked so ad hoc payouts get a
  // best-effort resolution attempt below and always leave an audit trail
  // either way - never a silent "trust whatever name was typed in".
  let destinationVerified = false;

  if (recipientCode) {
    const recipient = await findActiveByCodeForMerchant(merchantId, recipientCode);
    if (!recipient) throw new Error('unknown_or_inactive_recipient');
    if (mode === 'live' && !recipient.verified) {
      // See recipient.service.js#createRecipient / requirement: never pay
      // out to an account whose name hasn't been confirmed against the
      // bank (automatically) or an operator (manually). Test mode is
      // exempt since it never reaches a real bank anyway.
      throw new Error('recipient_not_verified');
    }
    destinationBankCode = recipient.bankCode;
    destinationAccountNumber = recipient.accountNumber;
    destinationAccountName = recipient.accountName;
    destinationVerified = recipient.verified;
  }

  if (!destinationBankCode || !destinationAccountNumber || !destinationAccountName) {
    throw new Error('destination_account_required');
  }

  // Ad hoc destination (no saved/verified Recipient) - best-effort
  // resolve it too, same as recipient creation does, rather than only
  // enforcing verification on the one path that happens to store a
  // reusable record. If the provider confirms a name, use it (never the
  // merchant-supplied one - see bankPartner.service.js). If resolution
  // isn't available, this is intentionally NOT blocked (raw one-off
  // payouts are an existing, relied-upon capability and RexxPay Bank's
  // resolution contract is unconfirmed - see resolveBankAccount()), but
  // it is flagged so ops has visibility instead of the mismatch being
  // invisible.
  if (!destinationVerified && mode === 'live') {
    try {
      const resolved = await resolveBankAccount({
        bankCode: destinationBankCode,
        accountNumber: destinationAccountNumber,
      });
      destinationAccountName = resolved.accountName;
      destinationVerified = true;
    } catch (err) {
      await auditLog.record({
        actorType: 'merchant',
        actorRef: merchantId,
        action: 'payout.unverified_destination_name',
        severity: 'warning',
        metadata: {
          destinationBankCode,
          reason: err.reason || err.message,
        },
      });
    }
  }

  // Fingerprint the SEMANTIC request - what's actually being asked for -
  // not the idempotency key itself. Computed after recipientCode is
  // resolved to actual account details, so a recipient's bank details
  // changing between two calls is caught too.
  const requestFingerprint = computeRequestFingerprint({
    amount,
    currency,
    destinationBankCode,
    destinationAccountNumber,
    destinationAccountName,
  });

  if (idempotencyKey) {
    const existing = await Payout.findOne({ merchant: merchantId, idempotencyKey, mode });
    if (existing) {
      assertFingerprintMatches(existing.requestFingerprint, {
        amount,
        currency,
        destinationBankCode,
        destinationAccountNumber,
        destinationAccountName,
      });
      return existing;
    }
  }

  const reference = `po_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let payout;
  try {
    session.startTransaction();

    if (mode === 'live') {
      const dayKey = new Date().toISOString().slice(0, 10);
      const outboundCounter = await DailyOutboundLimitCounter.findOneAndUpdate(
        { merchant: merchantId, currency, dayKey },
        { $inc: { totalSent: amount } },
        { new: true, upsert: true, session }
      );

      if (outboundCounter.totalSent > merchantLimits.MAX_DAILY_OUTBOUND_MINOR) {
        throw new Error('payout_exceeds_daily_outbound_limit');
      }
    }

    const payoutId = new mongoose.Types.ObjectId();

    await reserveFundsWithLedgerEntry({
      merchantId,
      amountMinorUnits: amount,
      currency,
      mode,
      session,
      entryGroup: `payout_${payoutId}`,
      sourceType: 'payout',
      sourceRef: payoutId.toString(),
      debitDescription: 'Payout requested - funds reserved',
      creditDescription: 'Funds moved to payout clearing pending bank confirmation',
    });

    const [created] = await Payout.create(
      [
        {
          _id: payoutId,
          merchant: merchantId,
          reference,
          idempotencyKey,
          requestFingerprint,
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

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    if (err.code === 11000 && idempotencyKey) {
      const raced = await Payout.findOne({ merchant: merchantId, idempotencyKey, mode });
      if (raced) {
        // Lost a race against a concurrent requestPayout() call using the
        // same idempotency key. Still worth checking the fingerprint here:
        // if the two concurrent calls disagreed about what they were
        // asking for, that's a client bug worth surfacing, not silently
        // hiding behind "return whichever one won".
        assertFingerprintMatches(raced.requestFingerprint, {
          amount,
          currency,
          destinationBankCode,
          destinationAccountNumber,
          destinationAccountName,
        });
        return raced;
      }
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
    const bankCall = mode === 'live' ? sendPayoutInstruction : simulatePayoutInstruction;

    const result = await bankCall({
      idempotencyKey: payout.reference,
      amountMajorUnits: toMajorUnits(amount),
      destinationAccountNumber,
      destinationBank: destinationBankCode,
      destinationAccountName,
    });

    if (!result.accepted) {
      await reversePayout(payout._id, result.failureReason || 'bank_rejected_submission');
    } else {
      payout.providerRef = result.providerReference || payout.providerRef;

      if (result.final === true) {
        if (result.success === true) {
          await finalizePayoutSuccess(payout._id, result.providerReference || null);
        } else {
          await reversePayout(payout._id, result.failureReason || 'bank_declined');
        }
      } else {
        payout.status = 'processing';
        await payout.save();

        const freshMerchant = await Merchant.findById(payout.merchant);
        if (freshMerchant) {
          dispatchMerchantWebhook(freshMerchant, {
            type: 'payout.processing',
            data: payout.toObject(),
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Either we genuinely don't know what the bank did (network-level
    // ambiguity from the bank client), or we DO know for certain the
    // bank already confirmed success and only our own bookkeeping
    // hiccuped afterward (localFinalizationFailure). Both cases get
    // treated the same way: parked as 'ambiguous' for a human (or
    // scripts/reconcile-outbound.js) to resolve with the real outcome -
    // NEVER auto-reversed, since in both cases the bank may have already
    // sent real money and reversing would falsely tell the merchant it
    // came back.
    if (err.ambiguousOutcome || err.localFinalizationFailure) {
      payout.status = 'ambiguous';
      payout.failureReason = err.localFinalizationFailure
        ? `local_finalization_failed_after_bank_success: ${err.message}`
        : `bank_call_ambiguous: ${err.message}`;
      await payout.save();

      await auditLog.record({
        actorType: 'system',
        actorRef: 'payout_service',
        action: 'payout.ambiguous_outcome',
        entityType: 'Payout',
        entityRef: payout._id.toString(),
        severity: 'critical',
        metadata: { error: err.message, localFinalizationFailure: !!err.localFinalizationFailure },
      });

      const merchant = await Merchant.findById(payout.merchant);
      if (merchant) {
        dispatchMerchantWebhook(merchant, { type: 'payout.ambiguous', data: payout.toObject() }).catch(() => {});
      }
    } else {
      // Only reached for errors we're confident mean "the bank never
      // received/queued this" (e.g. bank_rejected_submission,
      // bank_declined) - genuinely safe to reverse.
      await reversePayout(payout._id, err.message);
    }
  }

  return payout;
}

async function finalizePayoutSuccess(payoutId, providerReference = null) {
  const payout = await Payout.findOneAndUpdate(
    { _id: payoutId, status: { $in: ['processing', 'ambiguous'] } },
    { $set: { status: 'finalizing', ...(providerReference ? { providerRef: providerReference } : {}) } },
    { new: true }
  );

  if (!payout) return null;

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const wallet = await getOrCreateWallet(
      payout.merchant,
      payout.currency,
      payout.mode,
      session
    );

    await finalizeReservedDebit(wallet._id, payout.amount, session);

    payout.status = 'successful';
    if (providerReference) payout.providerRef = providerReference;
    payout.completedAt = new Date();
    await payout.save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    await Payout.updateOne(
      { _id: payout._id, status: 'finalizing' },
      { $set: { status: 'processing', failureReason: `finalization_failed: ${err.message}` } }
    );
    // IMPORTANT: the bank already told us this payout succeeded - a local
    // DB hiccup while recording that must NEVER be treated the same as
    // the bank rejecting the payout. Tag this so requestPayout's outer
    // catch (below) knows not to reverse it.
    err.localFinalizationFailure = true;
    throw err;
  }

  await auditLog.record({
    actorType: 'system',
    actorRef: 'payout_service',
    action: 'payout.successful',
    entityType: 'Payout',
    entityRef: payout._id.toString(),
    metadata: { amount: payout.amount, providerReference: payout.providerRef, mode: payout.mode },
  });

  const merchant = await Merchant.findById(payout.merchant);
  if (merchant) {
    dispatchMerchantWebhook(merchant, { type: 'payout.successful', data: payout.toObject() }).catch(() => {});
  }

  return payout;
}

async function reversePayout(payoutId, reason) {
  const payout = await Payout.findOneAndUpdate(
    { _id: payoutId, status: { $in: ['reserved', 'processing', 'ambiguous'] } },
    { $set: { status: 'reversing', failureReason: reason } },
    { new: true }
  );

  if (!payout) return null;

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const wallet = await getOrCreateWallet(
      payout.merchant,
      payout.currency,
      payout.mode,
      session
    );

    await releaseReservedFunds(wallet._id, payout.amount, session);

    await postDoubleEntry({
      entryGroup: `payout_reversal_${payout._id}`,
      amount: payout.amount,
      currency: payout.currency,
      mode: payout.mode,
      sourceType: 'reversal',
      sourceRef: payout._id.toString(),
      debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Payout reversal' },
      credit: { accountType: 'merchant_wallet', accountRef: payout.merchant.toString(), description: 'Payout reversal - funds returned' },
      session,
    });

    payout.status = 'failed';
    payout.completedAt = new Date();
    await payout.save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    await Payout.updateOne(
      { _id: payout._id, status: 'reversing' },
      { $set: { failureReason: `reversal_failed: ${err.message}` } }
    );
    throw err;
  }

  await auditLog.record({
    actorType: 'system',
    actorRef: 'payout_service',
    action: 'payout.reversed',
    entityType: 'Payout',
    entityRef: payout._id.toString(),
    severity: 'warning',
    metadata: { reason, mode: payout.mode },
  });

  const merchant = await Merchant.findById(payout.merchant);
  if (merchant) {
    dispatchMerchantWebhook(merchant, { type: 'payout.failed', data: payout.toObject() }).catch(() => {});
  }

  return payout;
}

async function confirmPayoutOutcome({ reference, success, providerRef = null, failureReason = null }) {
  const payout = await Payout.findOne({ reference });
  if (!payout) {
    await auditLog.record({
      actorType: 'system',
      actorRef: 'payout_webhook',
      action: 'payout.webhook_unknown_reference',
      severity: 'warning',
      metadata: { reference },
    });
    return null;
  }

  if (payout.status === 'successful' || payout.status === 'failed') return payout;

  if (success) {
    return finalizePayoutSuccess(payout._id, providerRef || payout.providerRef);
  }

  return reversePayout(payout._id, failureReason || 'bank_declined_after_submission');
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

module.exports = { requestPayout, requestBulkPayout, listForMerchant, confirmPayoutOutcome, finalizePayoutSuccess, reversePayout };
