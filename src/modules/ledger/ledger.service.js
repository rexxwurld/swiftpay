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

  const base = { entryGroup, amount, currency, sourceType, sourceRef };

  const [debitEntry, creditEntry] = await LedgerEntry.create(
    [
      { ...base, ...debit, direction: 'debit' },
      { ...base, ...credit, direction: 'credit' },
    ],
    { session, ordered: true }
  );

  return { debitEntry, creditEntry };
}

/** Running balance for an account, derived purely from ledger history. */
async function computeBalance(accountRef, session = null) {
  const pipeline = [
    { $match: { accountRef } },
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

async function historyForAccount(accountRef) {
  return LedgerEntry.find({ accountRef }).sort({ createdAt: -1 });
}

module.exports = { postDoubleEntry, computeBalance, historyForAccount };
