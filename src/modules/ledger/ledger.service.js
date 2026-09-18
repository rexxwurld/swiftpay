// src/modules/ledger/ledger.service.js
const mongoose = require('mongoose');
const LedgerEntry = require('./ledger.model');

/**
 * Posts a balanced double-entry pair: one debit, one credit, same amount,
 * same currency. Always call this instead of writing LedgerEntry directly,
 * so it's impossible to accidentally post an unbalanced entry.
 *
 * Example - money comes in from a customer and lands in a merchant wallet:
 *   debit:  platform_revenue clearing account (money left "the outside world")
 *   credit: merchant_wallet (merchant is now owed this money)
 *
 * @param {mongoose.ClientSession} session - required; ledger writes must
 *   happen in the same DB transaction as the wallet balance update, or the
 *   two can drift apart if one write succeeds and the other fails.
 */
async function postDoubleEntry({
  entryGroup,
  amount,
  currency = 'NGN',
  mode = 'live',
  sourceType,
  sourceRef,
  debit, // { accountType, accountRef, description }
  credit, // { accountType, accountRef, description }
  session,
}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('ledger_invalid_amount');
  }
  if (!session) {
    throw new Error('ledger_requires_session'); // enforce atomicity with wallet writes
  }
  if (mode !== 'test' && mode !== 'live') {
    throw new Error('ledger_invalid_mode');
  }

  const base = { entryGroup, amount, currency, mode, sourceType, sourceRef };

  const [debitEntry, creditEntry] = await LedgerEntry.create(
    [
      { ...base, ...debit, direction: 'debit' },
      { ...base, ...credit, direction: 'credit' },
    ],
    { session, ordered: true }
  );

  return { debitEntry, creditEntry };
}

/**
 * Running balance for an account, derived purely from ledger history.
 *
 * currency and mode are part of the account's real identity, not optional
 * filters - a "subaccount balance" that silently pools NGN and USD, or
 * test and live money, together is an accounting error, not a feature
 * (see audit report, High #12/#13). Callers must be explicit about which
 * (account, currency, mode) balance they mean.
 */
async function computeBalance(accountRef, { currency, mode, session = null } = {}) {
  if (!currency || (mode !== 'test' && mode !== 'live')) {
    throw new Error('compute_balance_requires_currency_and_mode');
  }

  const pipeline = [
    { $match: { accountRef, currency, mode } },
    {
      $group: {
        _id: null,
        credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } },
        debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } },
      },
    },
  ];

  const aggregate = LedgerEntry.aggregate(pipeline);

  if (session) {
    aggregate.session(session);
  }

  const [result] = await aggregate;

  if (!result) return 0;
  return result.credits - result.debits;
}

/**
 * All (currency, mode) balances for an account in one query - e.g. to show
 * a subaccount everything it's owed across currencies/modes, or to detect
 * that a settlement needs to be split rather than run as one number.
 */
async function computeBalancesByCurrencyAndMode(accountRef, session = null) {
  const pipeline = [
    { $match: { accountRef } },
    {
      $group: {
        _id: { currency: '$currency', mode: '$mode' },
        credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } },
        debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } },
      },
    },
  ];

  const aggregate = LedgerEntry.aggregate(pipeline);
  if (session) aggregate.session(session);

  const results = await aggregate;

  return results
    .map((r) => ({
      currency: r._id.currency,
      mode: r._id.mode,
      balance: r.credits - r.debits,
    }))
    .filter((r) => r.balance > 0);
}

async function historyForAccount(accountRef) {
  return LedgerEntry.find({ accountRef }).sort({ createdAt: -1 });
}

module.exports = { postDoubleEntry, computeBalance, computeBalancesByCurrencyAndMode, historyForAccount };
