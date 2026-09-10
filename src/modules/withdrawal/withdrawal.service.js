const mongoose = require('mongoose');
const crypto = require('crypto');
const Withdrawal = require('./withdrawal.model');
const Merchant = require('../merchant/merchant.model');
const DailyOutboundLimitCounter = require('../payout/dailyOutboundLimitCounter.model');
const { reserveFunds, finalizeReservedDebit, releaseReservedFunds, getOrCreateWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { sendPayoutInstruction, simulatePayoutInstruction } = require('../bankPartner/rexxPayBankClient');
const { dispatchMerchantWebhook } = require('../../utils/merchantWebhook');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

function toMajorUnits(amountMinorUnits) { return amountMinorUnits / 100; }

async function requestWithdrawal({ merchantId, amount, currency = 'NGN', idempotencyKey = null, mode }) {
  if (mode !== 'test' && mode !== 'live') throw new Error('withdrawal_mode_required');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('invalid_withdrawal_amount');

  const merchant = await Merchant.findById(merchantId);
  if (!merchant) throw new Error('merchant_not_found');

  const merchantLimits = limits.getLimitsForMerchant(merchant);
  if (amount > merchantLimits.MAX_SINGLE_PAYOUT_MINOR) throw new Error('withdrawal_exceeds_max_single_withdrawal_limit');

  if (idempotencyKey) {
    const existing = await Withdrawal.findOne({ merchant: merchantId, idempotencyKey, mode });
    if (existing) return existing;
  }

  const account = merchant.settlementAccount;
  if (!account?.bankCode || !account?.accountNumber || !account?.accountName) throw new Error('settlement_account_required');
  if (!account.verified) throw new Error('settlement_account_not_verified');

  const reference = `wd_${crypto.randomBytes(12).toString('hex')}`;
  const session = await mongoose.startSession();
  let withdrawal;

  try {
    session.startTransaction();

    // Daily outbound cap (ATOMIC) - shared with payout.service.js via the
    // same DailyOutboundLimitCounter collection, keyed by merchant +
    // currency + day. Withdrawals and payouts both draw from the same
    // wallet and both send money out, so they share one combined cap -
    // otherwise a merchant could dodge the limit just by splitting
    // requests between the two endpoints.
    if (mode === 'live') {
      const dayKey = new Date().toISOString().slice(0, 10);
      const outboundCounter = await DailyOutboundLimitCounter.findOneAndUpdate(
        { merchant: merchantId, currency, dayKey },
        { $inc: { totalSent: amount } },
        { new: true, upsert: true, session }
      );

      if (outboundCounter.totalSent > merchantLimits.MAX_DAILY_OUTBOUND_MINOR) {
        throw new Error('withdrawal_exceeds_daily_outbound_limit');
      }
    }

    await reserveFunds(merchantId, amount, session, currency, mode);

    const [created] = await Withdrawal.create([{
      merchant: merchantId, reference, idempotencyKey, amount, currency, mode,
      destinationBankCode: account.bankCode,
      destinationAccountNumber: account.accountNumber,
      destinationAccountName: account.accountName,
      status: 'reserved',
    }], { session, ordered: true });
    withdrawal = created;

    await postDoubleEntry({
      entryGroup: `withdrawal_${withdrawal._id}`,
      amount, currency, sourceType: 'withdrawal', sourceRef: withdrawal._id.toString(),
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Withdrawal requested - funds reserved' },
      credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Funds moved to withdrawal clearing pending bank confirmation' },
      session,
    });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction(); session.endSession();
    if (err.code === 11000 && idempotencyKey) {
      const raced = await Withdrawal.findOne({ merchant: merchantId, idempotencyKey, mode });
      if (raced) return raced;
    }
    throw err;
  }

  await auditLog.record({ actorType: 'merchant', actorRef: merchantId.toString(), action: 'withdrawal.requested', entityType: 'Withdrawal', entityRef: withdrawal._id.toString(), metadata: { amount, mode } });

  withdrawal.status = 'processing';
  withdrawal.submittedAt = new Date();
  await withdrawal.save();

  try {
    const bankCall = mode === 'live' ? sendPayoutInstruction : simulatePayoutInstruction;
    const result = await bankCall({
      idempotencyKey: withdrawal.reference,
      amountMajorUnits: toMajorUnits(amount),
      destinationAccountNumber: withdrawal.destinationAccountNumber,
      destinationBank: withdrawal.destinationBankCode,
      destinationAccountName: withdrawal.destinationAccountName,
    });

    withdrawal.providerRef = result.providerReference || withdrawal.providerRef;

    if (!result.accepted) {
      await reverseWithdrawal(withdrawal._id, result.failureReason || 'bank_rejected_submission');
    } else if (result.final === true) {
      if (result.success === true) await finalizeWithdrawalSuccess(withdrawal._id, result.providerReference || null);
      else await reverseWithdrawal(withdrawal._id, result.failureReason || 'bank_declined');
    } else {
      withdrawal.status = 'processing';
      await withdrawal.save();
      const freshMerchant = await Merchant.findById(withdrawal.merchant);
      if (freshMerchant) dispatchMerchantWebhook(freshMerchant, { type: 'withdrawal.processing', data: withdrawal.toObject() }).catch(() => {});
    }
  } catch (err) {
    if (err.ambiguousOutcome) {
      withdrawal.status = 'ambiguous';
      withdrawal.failureReason = `bank_call_ambiguous: ${err.message}`;
      await withdrawal.save();
      const freshMerchant = await Merchant.findById(withdrawal.merchant);
      if (freshMerchant) dispatchMerchantWebhook(freshMerchant, { type: 'withdrawal.ambiguous', data: withdrawal.toObject() }).catch(() => {});
    } else {
      await reverseWithdrawal(withdrawal._id, err.message);
    }
  }

  return Withdrawal.findById(withdrawal._id);
}

async function finalizeWithdrawalSuccess(withdrawalId, providerReference = null) {
  const withdrawal = await Withdrawal.findOneAndUpdate(
    { _id: withdrawalId, status: { $in: ['processing', 'ambiguous'] } },
    { $set: { status: 'finalizing', ...(providerReference ? { providerRef: providerReference } : {}) } },
    { new: true }
  );
  if (!withdrawal) return null;

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const wallet = await getOrCreateWallet(withdrawal.merchant, withdrawal.currency, withdrawal.mode, session);
    await finalizeReservedDebit(wallet._id, withdrawal.amount, session);
    withdrawal.status = 'successful';
    if (providerReference) withdrawal.providerRef = providerReference;
    withdrawal.completedAt = new Date();
    await withdrawal.save({ session });
    await session.commitTransaction(); session.endSession();
  } catch (err) {
    await session.abortTransaction(); session.endSession();
    await Withdrawal.updateOne({ _id: withdrawal._id, status: 'finalizing' }, { $set: { status: 'processing', failureReason: `finalization_failed: ${err.message}` } });
    throw err;
  }

  const merchant = await Merchant.findById(withdrawal.merchant);
  if (merchant) dispatchMerchantWebhook(merchant, { type: 'withdrawal.successful', data: withdrawal.toObject() }).catch(() => {});
  return withdrawal;
}

async function reverseWithdrawal(withdrawalId, reason) {
  const withdrawal = await Withdrawal.findOneAndUpdate(
    { _id: withdrawalId, status: { $in: ['processing', 'ambiguous'] } },
    { $set: { status: 'reversing', failureReason: reason } },
    { new: true }
  );
  if (!withdrawal) return null;

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const wallet = await getOrCreateWallet(withdrawal.merchant, withdrawal.currency, withdrawal.mode, session);
    await releaseReservedFunds(wallet._id, withdrawal.amount, session);
    await postDoubleEntry({
      entryGroup: `withdrawal_reversal_${withdrawal._id}`,
      amount: withdrawal.amount, currency: withdrawal.currency, sourceType: 'reversal', sourceRef: withdrawal._id.toString(),
      debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Withdrawal reversal' },
      credit: { accountType: 'merchant_wallet', accountRef: withdrawal.merchant.toString(), description: 'Withdrawal reversal - funds returned' },
      session,
    });
    withdrawal.status = 'failed'; withdrawal.completedAt = new Date();
    await withdrawal.save({ session });
    await session.commitTransaction(); session.endSession();
  } catch (err) {
    await session.abortTransaction(); session.endSession();
    await Withdrawal.updateOne({ _id: withdrawal._id, status: 'reversing' }, { $set: { failureReason: `reversal_failed: ${err.message}` } });
    throw err;
  }

  const merchant = await Merchant.findById(withdrawal.merchant);
  if (merchant) dispatchMerchantWebhook(merchant, { type: 'withdrawal.failed', data: withdrawal.toObject() }).catch(() => {});
  return withdrawal;
}

async function confirmWithdrawalOutcome({ reference, success, providerRef = null, failureReason = null }) {
  const withdrawal = await Withdrawal.findOne({ reference });
  if (!withdrawal) return null;
  if (withdrawal.status === 'successful' || withdrawal.status === 'failed') return withdrawal;
  if (success) return finalizeWithdrawalSuccess(withdrawal._id, providerRef || withdrawal.providerRef);
  return reverseWithdrawal(withdrawal._id, failureReason || 'bank_declined_after_submission');
}

async function listForMerchant(merchantId, mode = null) {
  const query = { merchant: merchantId };
  if (mode) query.mode = mode;
  return Withdrawal.find(query).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, withdrawalId) {
  const withdrawal = await Withdrawal.findOne({ _id: withdrawalId, merchant: merchantId });
  if (!withdrawal) throw new Error('withdrawal_not_found');
  return withdrawal;
}

module.exports = { requestWithdrawal, confirmWithdrawalOutcome, finalizeWithdrawalSuccess, reverseWithdrawal, listForMerchant, getForMerchant };
