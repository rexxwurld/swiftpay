// src/modules/subaccount/subaccount.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const Subaccount = require('./subaccount.model');
const SubaccountSettlement = require('./subaccountSettlement.model');
const { postDoubleEntry, computeBalance } = require('../ledger/ledger.service');
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

async function getBalance(subaccountId) {
  return computeBalance(subaccountId.toString());
}

// NOTE: same stub-disbursement pattern as payout.service.js / refund.service.js.
async function sendSettlementToBank(settlement) {
  return { success: true, providerRef: `sim_${settlement.reference}` };
}

// Pays out the subaccount's ENTIRE accrued ledger balance to its
// settlement bank account. Triggered explicitly by the parent merchant -
// never automatic, so the parent controls the settlement cadence.
async function settleSubaccount({ merchantId, subaccountId }) {
  const subaccount = await getForMerchant(merchantId, subaccountId);
  const reference = `sst_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let settlement;
  try {
    session.startTransaction();
    const balance = await getBalance(subaccountId);

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
          status: 'processing',
        },
      ],
      { session, ordered: true }
    );
    settlement = created;

    await postDoubleEntry({
      entryGroup: `subaccount_settlement_${settlement._id}`,
      amount: balance,
      sourceType: 'payout',
      sourceRef: settlement._id.toString(),
      debit: { accountType: 'subaccount_settlement', accountRef: subaccount._id.toString(), description: 'Subaccount balance settled out' },
      credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Funds moved to clearing pending bank confirmation' },
      session,
    });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'subaccount.settled',
    entityType: 'SubaccountSettlement',
    entityRef: settlement._id.toString(),
    metadata: { subaccountId: subaccountId.toString(), amount: balance },
  });

  try {
    const result = await sendSettlementToBank(settlement);
    settlement.status = result.success ? 'successful' : 'failed';
    settlement.providerRef = result.providerRef || null;
    if (!result.success) settlement.failureReason = result.reason || 'provider_declined';
    await settlement.save();

    if (!result.success) {
      await reverseSettlement(settlement);
    }
  } catch (err) {
    settlement.failureReason = `provider_call_error: ${err.message}`;
    await settlement.save();
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
