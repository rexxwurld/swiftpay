// src/modules/transaction/transaction.service.js
const mongoose = require('mongoose');

const Transaction = require('./transaction.model');
const Customer = require('../customer/customer.model');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const DailyLimitCounter = require('./dailyLimitCounter.model');
const VelocityCounter = require('./velocityCounter.model');

const { creditPendingSettlement } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');

const { screenName } = require('../../utils/sanctionsCheck');
const { computeFee } = require('../../utils/feeCalculator');

const Merchant = require('../merchant/merchant.model');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

async function recordIncomingPayment({
  reference,
  merchantId,
  customerId,
  virtualAccountId,
  amountReceived,
  amountExpected,
  currency,
  bankReference,
}) {
    if (!bankReference || typeof bankReference !== 'string' || !bankReference.trim()) {
    throw new Error('missing_bank_reference');
  }

  bankReference = bankReference.trim();
  
  const existing = await Transaction.findOne({ bankReference });
  if (existing) {
    return { transaction: existing, duplicate: true };
  }

  const merchant = await Merchant.findById(merchantId);
  const merchantLimits = limits.getLimitsForMerchant(merchant);

  let flagReason = null;

  if (amountReceived < merchantLimits.MIN_SINGLE_PAYMENT_MINOR) {
    flagReason = 'below_min_single_payment';
  }

  if (!flagReason && amountReceived > merchantLimits.MAX_SINGLE_PAYMENT_MINOR) {
    flagReason = 'exceeds_max_single_payment';
  }

  let sanctionsFlagReason = null;
  if (!flagReason) {
    const customer = await Customer.findById(customerId);
    if (customer) {
      const screening = screenName(customer.fullName);
      if (screening.hit) {
        sanctionsFlagReason = `sanctions_screen:${screening.reason}`;
      }
    }
  }

  const virtualAccount = await VirtualAccount.findById(virtualAccountId);
  if (!virtualAccount) {
    throw new Error('virtual_account_not_found');
  }

  const mode = virtualAccount.mode || 'live';

  const hasSplit = !!(virtualAccount.splitSubaccount && virtualAccount.splitPercentage);
  const splitAmount = hasSplit ? Math.floor((amountReceived * virtualAccount.splitPercentage) / 100) : 0;
  const merchantAmount = amountReceived - splitAmount;

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (!flagReason) {
      const velocityWindowMs = merchantLimits.VELOCITY_WINDOW_MINUTES * 60 * 1000;
      const windowKey = String(Math.floor(Date.now() / velocityWindowMs));

      const velocityCounter = await VelocityCounter.findOneAndUpdate(
        { virtualAccount: virtualAccountId, windowKey },
        { $inc: { count: 1 } },
        { new: true, upsert: true, session }
      );

      if (velocityCounter.count > merchantLimits.VELOCITY_MAX_COUNT) {
        flagReason = 'velocity_limit_exceeded';
      }
    }

    if (!flagReason) {
      const dayKey = new Date().toISOString().slice(0, 10);

      const dailyCounter = await DailyLimitCounter.findOneAndUpdate(
        { merchant: merchantId, currency, dayKey },
        { $inc: { totalReceived: amountReceived } },
        { new: true, upsert: true, session }
      );

      if (dailyCounter.totalReceived > merchantLimits.MAX_DAILY_INBOUND_MINOR) {
        flagReason = 'exceeds_daily_inbound_limit';
      }
    }

    if (!flagReason && sanctionsFlagReason) {
      flagReason = sanctionsFlagReason;
    }

    let status;
    if (flagReason) {
      status = 'flagged';
    } else if (amountExpected != null && amountReceived < amountExpected) {
      status = 'partial';
    } else if (amountExpected != null && amountReceived > amountExpected) {
      status = 'over';
    } else {
      status = 'success';
    }

    let platformFee = 0;
    let netAmount = merchantAmount;

    if (status !== 'flagged' && status !== 'failed' && merchantAmount > 0) {
      ({ feeAmount: platformFee, netAmount } = computeFee(merchantAmount, merchant));
    }

    const willCreditMerchant = status !== 'flagged' && status !== 'failed' && netAmount > 0;

    const [transaction] = await Transaction.create(
      [
        {
          reference,
          merchant: merchantId,
          customer: customerId,
          virtualAccount: virtualAccountId,
          mode,
          amountExpected: amountExpected ?? null,
          amountReceived,
          currency,
          status,
          flagReason,
          bankReference,
          splitSubaccount: hasSplit ? virtualAccount.splitSubaccount : null,
          splitAmount,
          platformFee,
          netAmount,
          settlementStatus: willCreditMerchant ? 'pending_settlement' : null,
        },
      ],
      { session, ordered: true }
    );

    if (status !== 'flagged' && status !== 'failed') {
      if (hasSplit) {
        if (netAmount > 0) {
          await creditPendingSettlement(merchantId, netAmount, session, currency, mode);

          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: netAmount,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:merchant`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Inbound customer payment received' },
            credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Wallet credited for inbound payment (net of split and platform fee) - pending settlement' },
            session,
          });
        }

        if (platformFee > 0) {
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: platformFee,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:fee`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Platform fee taken from inbound payment' },
            credit: { accountType: 'platform_revenue', accountRef: 'platform_revenue', description: 'Platform fee revenue' },
            session,
          });
        }

        if (splitAmount > 0) {
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: splitAmount,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:split`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Inbound customer payment received (split portion)' },
            credit: { accountType: 'subaccount_settlement', accountRef: virtualAccount.splitSubaccount.toString(), description: 'Subaccount split credited' },
            session,
          });
        }
      } else {
        if (netAmount > 0) {
          await creditPendingSettlement(merchantId, netAmount, session, currency, mode);

          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: netAmount,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: transaction._id.toString(),
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Inbound customer payment received' },
            credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Wallet credited for inbound payment (net of platform fee) - pending settlement' },
            session,
          });
        }

        if (platformFee > 0) {
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: platformFee,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:fee`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Platform fee taken from inbound payment' },
            credit: { accountType: 'platform_revenue', accountRef: 'platform_revenue', description: 'Platform fee revenue' },
            session,
          });
        }
      }
    }

    await session.commitTransaction();
    session.endSession();

    await auditLog.record({
      actorType: 'system',
      actorRef: 'webhook_processor',
      action: status === 'flagged' ? 'transaction.flagged' : 'transaction.recorded',
      entityType: 'Transaction',
      entityRef: transaction._id.toString(),
      severity: status === 'flagged' ? 'critical' : 'info',
      metadata: { status, flagReason, amountReceived, mode, merchantId: merchantId.toString() },
    });

    return { transaction, duplicate: false };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    if (err.code === 11000 && bankReference) {
  const existingRace = await Transaction.findOne({
    bankReference,
  });

  if (existingRace) {
    return { transaction: existingRace, duplicate: true };
  }
    }

    throw err;
  }
}
async function resolveFlaggedTransaction({
  reference,
  action,
}) {
  if (!['release', 'reject'].includes(action)) {
    throw new Error('invalid_flag_resolution_action');
  }

  const session = await mongoose.startSession();

  try {
    let transaction;

    await session.withTransaction(async () => {
      transaction = await Transaction.findOneAndUpdate(
        {
          reference,
          status: 'flagged',
        },
        {
          $set: {
            status: action === 'reject' ? 'failed' : 'pending',
          },
        },
        {
          new: true,
          session,
        }
      );

      if (!transaction) {
        throw new Error('flagged_transaction_not_found_or_already_resolved');
      }

      if (action === 'reject') {
        transaction.status = 'failed';
        transaction.settlementStatus = null;
        await transaction.save({ session });
        return;
      }

      const merchant = await Merchant.findById(transaction.merchant).session(session);
      if (!merchant) {
        throw new Error('merchant_not_found');
      }

      const virtualAccount = await VirtualAccount
        .findById(transaction.virtualAccount)
        .session(session);

      if (!virtualAccount) {
        throw new Error('virtual_account_not_found');
      }

      const hasSplit = !!(
        transaction.splitSubaccount &&
        virtualAccount.splitPercentage
      );

      const splitAmount = hasSplit
        ? Math.floor(
            (transaction.amountReceived * virtualAccount.splitPercentage) / 100
          )
        : 0;

      const merchantAmount = transaction.amountReceived - splitAmount;

      let platformFee = 0;
      let netAmount = merchantAmount;

      if (merchantAmount > 0) {
        ({ feeAmount: platformFee, netAmount } = computeFee(
          merchantAmount,
          merchant
        ));
      }

      transaction.status =
        transaction.amountExpected != null &&
        transaction.amountReceived < transaction.amountExpected
          ? 'partial'
          : transaction.amountExpected != null &&
              transaction.amountReceived > transaction.amountExpected
            ? 'over'
            : 'success';

      transaction.flagReason = transaction.flagReason;
      transaction.splitAmount = splitAmount;
      transaction.platformFee = platformFee;
      transaction.netAmount = netAmount;
      transaction.settlementStatus =
        netAmount > 0 ? 'pending_settlement' : null;

      await transaction.save({ session });

      if (netAmount > 0) {
        await creditPendingSettlement(
          transaction.merchant,
          netAmount,
          session,
          transaction.currency,
          transaction.mode
        );

        await postDoubleEntry({
          entryGroup: `txn_${transaction._id}:manual_release:merchant`,
          amount: netAmount,
          currency: transaction.currency,
          sourceType: 'flagged_transaction_release',
          sourceRef: transaction._id.toString(),
          debit: {
            accountType: 'payout_clearing',
            accountRef: 'platform_clearing',
            description: 'Flagged inbound payment released to merchant - pending settlement',
          },
          credit: {
            accountType: 'merchant_wallet',
            accountRef: transaction.merchant.toString(),
            description: 'Flagged inbound payment released to merchant',
          },
          session,
        });
      }

      if (platformFee > 0) {
        await postDoubleEntry({
          entryGroup: `txn_${transaction._id}:manual_release:fee`,
          amount: platformFee,
          currency: transaction.currency,
          sourceType: 'flagged_transaction_release',
          sourceRef: transaction._id.toString(),
          debit: {
            accountType: 'payout_clearing',
            accountRef: 'platform_clearing',
            description: 'Platform fee taken from released flagged payment',
          },
          credit: {
            accountType: 'platform_revenue',
            accountRef: 'platform_revenue',
            description: 'Platform fee revenue from released flagged payment',
          },
          session,
        });
      }

      if (splitAmount > 0) {
        await postDoubleEntry({
          entryGroup: `txn_${transaction._id}:manual_release:split`,
          amount: splitAmount,
          currency: transaction.currency,
          sourceType: 'flagged_transaction_release',
          sourceRef: transaction._id.toString(),
          debit: {
            accountType: 'payout_clearing',
            accountRef: 'platform_clearing',
            description: 'Split portion of released flagged payment',
          },
          credit: {
            accountType: 'subaccount_settlement',
            accountRef: transaction.splitSubaccount.toString(),
            description: 'Subaccount split from released flagged payment',
          },
          session,
        });
      }
    });

    await auditLog.record({
      actorType: 'admin',
      actorRef: 'manual_flag_resolution',
      action:
        action === 'release'
          ? 'transaction.flagged_released'
          : 'transaction.flagged_rejected',
      entityType: 'Transaction',
      entityRef: transaction._id.toString(),
      severity: 'critical',
      metadata: {
        reference: transaction.reference,
        action,
        amountReceived: transaction.amountReceived,
        currency: transaction.currency,
        mode: transaction.mode,
        merchantId: transaction.merchant.toString(),
        flagReason: transaction.flagReason,
      },
    });

    return transaction;
  } finally {
    await session.endSession();
  }
}

async function listForMerchant(merchantId, mode = null) {
  const query = { merchant: merchantId };
  if (mode) query.mode = mode;
  return Transaction.find(query).sort({ createdAt: -1 });
}

module.exports = {
  recordIncomingPayment,
  resolveFlaggedTransaction,
  listForMerchant,
};
