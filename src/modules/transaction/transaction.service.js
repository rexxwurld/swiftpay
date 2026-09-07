// src/modules/transaction/transaction.service.js
const mongoose = require('mongoose');

const Transaction = require('./transaction.model');
const Customer = require('../customer/customer.model');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');

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
  const existing = await Transaction.findOne({ reference });
  if (existing) {
    return { transaction: existing, duplicate: true };
  }

  // Loaded up front now (previously only fetched later, just for fees) -
  // limit checks below are plan-aware and need it too.
  const merchant = await Merchant.findById(merchantId);
  const merchantLimits = limits.getLimitsForMerchant(merchant);

  let flagReason = null;

  // Belt-and-braces: payment.service.js already rejects amount_below_minimum
  // at initialize time, but a customer can still manually transfer an
  // arbitrary amount to an already-assigned virtual account, bypassing
  // that check entirely. Flag rather than reject outright - the money has
  // already physically moved, so it needs a human decision (refund vs.
  // manual credit), not a silent drop.
  if (amountReceived < merchantLimits.MIN_SINGLE_PAYMENT_MINOR) {
    flagReason = 'below_min_single_payment';
  }

  if (!flagReason && amountReceived > merchantLimits.MAX_SINGLE_PAYMENT_MINOR) {
    flagReason = 'exceeds_max_single_payment';
  }

  if (!flagReason) {
    const windowStart = new Date(Date.now() - merchantLimits.VELOCITY_WINDOW_MINUTES * 60 * 1000);
    const recentCount = await Transaction.countDocuments({
      virtualAccount: virtualAccountId,
      createdAt: { $gte: windowStart },
    });
    if (recentCount >= merchantLimits.VELOCITY_MAX_COUNT) {
      flagReason = 'velocity_limit_exceeded';
    }
  }

  if (!flagReason) {
    const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [dailyAgg] = await Transaction.aggregate([
      { $match: { merchant: merchantId, createdAt: { $gte: dayStart }, status: { $in: ['success', 'partial', 'over'] } } },
      { $group: { _id: null, total: { $sum: '$amountReceived' } } },
    ]);
    const dailyTotal = (dailyAgg?.total || 0) + amountReceived;
    if (dailyTotal > merchantLimits.MAX_DAILY_INBOUND_MINOR) {
      flagReason = 'exceeds_daily_inbound_limit';
    }
  }

  if (!flagReason) {
    const customer = await Customer.findById(customerId);
    if (customer) {
      const screening = screenName(customer.fullName);
      if (screening.hit) {
        flagReason = `sanctions_screen:${screening.reason}`;
      }
    }
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

  const virtualAccount = await VirtualAccount.findById(virtualAccountId);
  if (!virtualAccount) {
    throw new Error('virtual_account_not_found');
  }

  // The transaction's mode comes from the account it landed on, not
  // from anywhere else - this is the single source of truth for
  // whether this money is real.
  const mode = virtualAccount.mode || 'live';

  const hasSplit = !!(virtualAccount.splitSubaccount && virtualAccount.splitPercentage);
  const splitAmount = hasSplit ? Math.floor((amountReceived * virtualAccount.splitPercentage) / 100) : 0;
  const merchantAmount = amountReceived - splitAmount;

  let platformFee = 0;
  let netAmount = merchantAmount;

  if (status !== 'flagged' && status !== 'failed' && merchantAmount > 0) {
    ({ feeAmount: platformFee, netAmount } = computeFee(merchantAmount, merchant));
  }

  const willCreditMerchant = status !== 'flagged' && status !== 'failed' && netAmount > 0;

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

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

    if (err.code === 11000) {
      const existingRace = await Transaction.findOne({ reference });
      if (existingRace) {
        return { transaction: existingRace, duplicate: true };
      }
    }

    throw err;
  }
}

async function listForMerchant(merchantId, mode = null) {
  const query = { merchant: merchantId };
  if (mode) query.mode = mode;
  return Transaction.find(query).sort({ createdAt: -1 });
}

module.exports = { recordIncomingPayment, listForMerchant };
