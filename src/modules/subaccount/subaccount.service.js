// src/modules/subaccount/subaccount.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const Subaccount = require('./subaccount.model');
const SubaccountSettlement = require('./subaccountSettlement.model');
const { postDoubleEntry, computeBalancesByCurrencyAndMode } = require('../ledger/ledger.service');
const { sendPayoutInstruction, simulatePayoutInstruction } = require('../bankPartner/rexxPayBankClient');
const auditLog = require('../audit/auditLog.service');

async function createSubaccount({
  merchantId,
  businessName,
  settlementBankCode,
  settlementAccountNumber,
  settlementAccountName,
  defaultSplitPercentage,
}) {
  if (!businessName || !settlementBankCode || !settlementAccountNumber || !settlementAccountName) {
    throw new Error('missing_required_fields');
  }
  if (
    defaultSplitPercentage != null &&
    (!Number.isFinite(defaultSplitPercentage) || defaultSplitPercentage <= 0 || defaultSplitPercentage > 100)
  ) {
    throw new Error('invalid_default_split_percentage');
  }

  return Subaccount.create({
    merchant: merchantId,
    subaccountCode: `sub_${nanoid(16)}`,
    businessName,
    settlementBankCode,
    settlementAccountNumber,
    settlementAccountName,
    defaultSplitPercentage: defaultSplitPercentage ?? null,
  });
}

async function listForMerchant(merchantId) {
  return Subaccount.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, subaccountId) {
  const subaccount = await Subaccount.findOne({ _id: subaccountId, merchant: merchantId });
  if (!subaccount) throw new Error('subaccount_not_found');
  return subaccount;
}

// Scoped to the parent merchant, since only that merchant's checkouts
// are allowed to route a split to this subaccount.
async function findActiveByCodeForMerchant(merchantId, subaccountCode) {
  return Subaccount.findOne({ subaccountCode, merchant: merchantId, active: true });
}

// A subaccount has no wallet of its own, so its balance is whatever the
// ledger says it is. Returned as one entry PER (currency, mode) - never
// pooled into a single number, since NGN and USD (or test and live) are
// not fungible with each other (see audit report, High #12/#13).
async function getBalance(subaccountId) {
  return computeBalancesByCurrencyAndMode(subaccountId.toString());
}

async function sendSettlementToBank(settlement, subaccount) {
  const bankCall = settlement.mode === 'live'
    ? sendPayoutInstruction
    : simulatePayoutInstruction;

  return bankCall({
    idempotencyKey: settlement.reference,
    amountMajorUnits: settlement.amount / 100,
    destinationAccountNumber: subaccount.settlementAccountNumber,
    destinationBank: subaccount.settlementBankCode,
    destinationAccountName: subaccount.settlementAccountName,
  });
}

// Pays out the subaccount's ENTIRE accrued ledger balance to its
// settlement bank account, one settlement per (currency, mode) bucket.
// Triggered explicitly by the parent merchant - never automatic, so the
// parent controls the settlement cadence.
//
// IMPORTANT: a subaccount can hold balances in more than one currency and
// in both test and live mode at once (e.g. from checkouts across several
// virtual accounts). Settling it is NOT "one number out to one bank
// account" - it's a separate settlement per bucket, each with its own
// bank call, so live NGN money is never mixed with, say, test-mode or
// USD money (see audit report, High #12/#13).
async function settleSubaccount({ merchantId, subaccountId }) {
  const subaccount = await getForMerchant(merchantId, subaccountId);
  const buckets = await getBalance(subaccountId);

  if (!buckets.length) {
    throw new Error('no_balance_to_settle');
  }

  const settlements = [];
  for (const bucket of buckets) {
    settlements.push(await settleSubaccountBucket({ merchantId, subaccount, subaccountId, ...bucket }));
  }

  return settlements;
}

// Settles exactly one (currency, mode) bucket. Split out of
// settleSubaccount() so buckets are processed one at a time - each still
// gets its own settlementVersion-bump write-conflict lock (see below), but
// running them sequentially avoids two buckets for the same subaccount
// racing each other inside the same request.
async function settleSubaccountBucket({ merchantId, subaccount, subaccountId, currency, mode }) {
  const reference = `sst_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let settlement;
  let balance;

  try {
    await session.withTransaction(async () => {
      // Serialize settlement attempts for this subaccount. Two
      // simultaneous settlement requests both writing to the same
      // Subaccount document inside a transaction will cause MongoDB to
      // abort one of them with a write conflict (retried automatically
      // by withTransaction), so they cannot both read the same
      // not-yet-debited balance and both settle it.
      await Subaccount.findOneAndUpdate(
        {
          _id: subaccount._id,
          merchant: merchantId,
        },
        {
          $inc: { settlementVersion: 1 },
        },
        {
          session,
          new: true,
        }
      );

      // Re-read the balance for THIS bucket only, inside the same
      // transaction, so it reflects anything posted since getBalance()
      // was called above.
      const freshBuckets = await computeBalancesByCurrencyAndMode(subaccountId.toString(), session);
      const fresh = freshBuckets.find((b) => b.currency === currency && b.mode === mode);
      balance = fresh ? fresh.balance : 0;

      if (balance <= 0) {
        throw new Error('no_balance_to_settle');
      }

      const [created] = await SubaccountSettlement.create(
        [
          {
            subaccount: subaccount._id,
            parentMerchant: merchantId,
            reference,
            amount: balance,
            currency,
            mode,
            status: 'processing',
          },
        ],
        { session, ordered: true }
      );

      settlement = created;

      await postDoubleEntry({
        entryGroup: `subaccount_settlement_${settlement._id}`,
        amount: balance,
        currency,
        mode,
        sourceType: 'payout',
        sourceRef: settlement._id.toString(),
        debit: {
          accountType: 'subaccount_settlement',
          accountRef: subaccount._id.toString(),
          description: 'Subaccount balance settled out',
        },
        credit: {
          accountType: 'payout_clearing',
          accountRef: 'platform_clearing',
          description: 'Funds moved to clearing pending bank confirmation',
        },
        session,
      });
    });
  } finally {
    session.endSession();
  }

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'subaccount.settled',
    entityType: 'SubaccountSettlement',
    entityRef: settlement._id.toString(),
    metadata: {
      subaccountId: subaccountId.toString(),
      amount: balance,
      currency,
      mode,
    },
  });

  try {
    const result = await sendSettlementToBank(settlement, subaccount);

    if (!result.accepted) {
      settlement.status = 'failed';
      settlement.failureReason = result.failureReason || 'bank_rejected_submission';
      settlement.providerRef = result.providerReference || null;
      await settlement.save();

      await reverseSettlement(settlement);
    } else {
      settlement.providerRef = result.providerReference || settlement.providerRef;

      if (result.final === true) {
        if (result.success === true) {
          settlement.status = 'successful';
          await settlement.save();
        } else {
          settlement.status = 'failed';
          settlement.failureReason = result.failureReason || 'bank_declined';
          await settlement.save();

          await reverseSettlement(settlement);
        }
      } else {
        // Bank accepted the instruction but has not given
        // a final outcome yet. Keep the funds in clearing.
        settlement.status = 'processing';
        await settlement.save();
      }
    }
  } catch (err) {
    // A network error or provider-side uncertainty does NOT mean
    // the bank rejected the transfer. The bank may already have
    // accepted or executed it.
    //
    // NEVER reverse an ambiguous bank outcome automatically.
    settlement.status = 'ambiguous';
    settlement.failureReason = `bank_call_ambiguous: ${err.message}`;

    try {
      await settlement.save();
    } catch (saveErr) {
      // The original bank outcome remains unknown. Do not attempt
      // a reversal just because local bookkeeping failed.
      await auditLog.record({
        actorType: 'system',
        actorRef: 'subaccount_settlement_service',
        action: 'subaccount_settlement.local_save_failed_after_bank_call',
        entityType: 'SubaccountSettlement',
        entityRef: settlement._id.toString(),
        severity: 'critical',
        metadata: {
          originalError: err.message,
          saveError: saveErr.message,
        },
      }).catch(() => {});
    }

    await auditLog.record({
      actorType: 'system',
      actorRef: 'subaccount_settlement_service',
      action: 'subaccount_settlement.ambiguous_outcome',
      entityType: 'SubaccountSettlement',
      entityRef: settlement._id.toString(),
      severity: 'critical',
      metadata: {
        error: err.message,
        providerRef: settlement.providerRef,
      },
    }).catch(() => {});
  }

  return settlement;
}

async function reverseSettlement(settlement) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await postDoubleEntry({
      entryGroup: `subaccount_settlement_reversal_${settlement._id}`,
      amount: settlement.amount,
      currency: settlement.currency,
      mode: settlement.mode,
      sourceType: 'reversal',
      sourceRef: settlement._id.toString(),
      debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Subaccount settlement reversal' },
      credit: { accountType: 'subaccount_settlement', accountRef: settlement.subaccount.toString(), description: 'Settlement reversal - balance restored' },
      session,
    });
    settlement.status = 'reversed';
    await settlement.save({ session });
    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

module.exports = {
  createSubaccount,
  listForMerchant,
  getForMerchant,
  findActiveByCodeForMerchant,
  getBalance,
  settleSubaccount,
};
