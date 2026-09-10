// src/modules/wallet/wallet.service.js
const Wallet = require('./wallet.model');
const { normalizeCurrency } = require('../../config/currencies');
const { postDoubleEntry } = require('../ledger/ledger.service');

// `mode` defaults to 'test' everywhere in this file, NOT 'live'. If a
// caller ever forgets to pass mode explicitly, it should fail closed
// into an empty test wallet (insufficient_balance) rather than silently
// reading/writing real money.
function normalizeMode(mode) {
  return mode === 'live' ? 'live' : 'test';
}

async function getOrCreateWallet(merchantId, currency = 'NGN', mode = 'test', session = null) {
  const cur = normalizeCurrency(currency);
  const m = normalizeMode(mode);
  let wallet = await Wallet.findOne({ merchant: merchantId, currency: cur, mode: m }).session(session);
  if (!wallet) {
    const created = await Wallet.create([{ merchant: merchantId, balance: 0, currency: cur, mode: m }], { session });
    wallet = created[0];
  }
  return wallet;
}

// mode = null means "every mode" - used by dashboard views that show
// both test and live wallets together, tagged by their own `mode` field.
async function listWallets(merchantId, mode = null) {
  const query = { merchant: merchantId };
  if (mode) query.mode = normalizeMode(mode);
  return Wallet.find(query).sort({ currency: 1, mode: 1 });
}

async function creditWallet(merchantId, amountMinorUnits, session = null, currency = 'NGN', mode = 'test') {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_credit_amount');
  }
  const cur = normalizeCurrency(currency);
  const m = normalizeMode(mode);
  await getOrCreateWallet(merchantId, cur, m, session);
  return Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur, mode: m },
    { $inc: { balance: amountMinorUnits } },
    { new: true, session }
  );
}

async function debitWallet(merchantId, amountMinorUnits, session = null, currency = 'NGN', mode = 'test') {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_debit_amount');
  }
  const cur = normalizeCurrency(currency);
  const m = normalizeMode(mode);
  const wallet = await Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur, mode: m, balance: { $gte: amountMinorUnits } },
    { $inc: { balance: -amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('insufficient_balance');
  return wallet;
}

async function creditPendingSettlement(merchantId, amountMinorUnits, session, currency = 'NGN', mode = 'test') {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_credit_amount');
  }
  const cur = normalizeCurrency(currency);
  const m = normalizeMode(mode);
  await getOrCreateWallet(merchantId, cur, m, session);
  return Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur, mode: m },
    { $inc: { pendingSettlementBalance: amountMinorUnits } },
    { new: true, session }
  );
}

// --- Ledgered wrappers ---------------------------------------------------
//
// The two wallet-mutating operations below (reserveFunds,
// creditPendingSettlement) are ALWAYS supposed to be paired with a
// matching postDoubleEntry() ledger post in the same DB transaction -
// otherwise the ledger silently stops being a true record of what
// happened to the wallet. Previously this pairing only existed by
// convention (every call site happened to remember to do both). These
// wrappers make it structural instead: call one function, get both the
// wallet change AND the ledger entry, in the same transaction, guaranteed.
//
// Existing call sites don't have to switch to these immediately - nothing
// breaks if they don't - but any NEW code moving wallet money should
// prefer these over calling reserveFunds/creditPendingSettlement and
// postDoubleEntry separately.

async function reserveFundsWithLedgerEntry({
  merchantId,
  amountMinorUnits,
  currency,
  mode,
  session,
  entryGroup,
  sourceType,
  sourceRef,
  debitDescription = 'Funds reserved',
  creditAccountType = 'payout_clearing',
  creditAccountRef = 'platform_clearing',
  creditDescription = 'Funds moved to clearing pending confirmation',
}) {
  const wallet = await reserveFunds(merchantId, amountMinorUnits, session, currency, mode);

  await postDoubleEntry({
    entryGroup,
    amount: amountMinorUnits,
    currency,
    sourceType,
    sourceRef,
    debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: debitDescription },
    credit: { accountType: creditAccountType, accountRef: creditAccountRef, description: creditDescription },
    session,
  });

  return wallet;
}

async function creditPendingSettlementWithLedgerEntry({
  merchantId,
  amountMinorUnits,
  currency,
  mode,
  session,
  entryGroup,
  sourceType,
  sourceRef,
  creditDescription = 'Wallet credited - pending settlement',
  debitAccountType = 'payout_clearing',
  debitAccountRef = 'platform_clearing',
  debitDescription = 'Inbound payment received',
}) {
  const wallet = await creditPendingSettlement(merchantId, amountMinorUnits, session, currency, mode);

  await postDoubleEntry({
    entryGroup,
    amount: amountMinorUnits,
    currency,
    sourceType,
    sourceRef,
    debit: { accountType: debitAccountType, accountRef: debitAccountRef, description: debitDescription },
    credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: creditDescription },
    session,
  });

  return wallet;
}

// Unchanged below - these operate on a walletId that's already scoped
// to a specific mode, so there's nothing to thread through.

async function moveToAvailable(walletId, amountMinorUnits, session) {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_settlement_amount');
  }
  const wallet = await Wallet.findOneAndUpdate(
    { _id: walletId, pendingSettlementBalance: { $gte: amountMinorUnits } },
    { $inc: { pendingSettlementBalance: -amountMinorUnits, balance: amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('insufficient_pending_settlement_balance');
  return wallet;
}

async function reserveFunds(merchantId, amountMinorUnits, session, currency = 'NGN', mode = 'test') {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_reserve_amount');
  }
  const cur = normalizeCurrency(currency);
  const m = normalizeMode(mode);
  const wallet = await Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur, mode: m, balance: { $gte: amountMinorUnits } },
    { $inc: { balance: -amountMinorUnits, reservedBalance: amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('insufficient_balance');
  return wallet;
}

async function finalizeReservedDebit(walletId, amountMinorUnits, session) {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_finalize_amount');
  }
  const wallet = await Wallet.findOneAndUpdate(
    { _id: walletId, reservedBalance: { $gte: amountMinorUnits } },
    { $inc: { reservedBalance: -amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('reserved_balance_mismatch');
  return wallet;
}

async function releaseReservedFunds(walletId, amountMinorUnits, session) {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_release_amount');
  }
  const wallet = await Wallet.findOneAndUpdate(
    { _id: walletId, reservedBalance: { $gte: amountMinorUnits } },
    { $inc: { reservedBalance: -amountMinorUnits, balance: amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('reserved_balance_mismatch');
  return wallet;
}

module.exports = {
  getOrCreateWallet,
  listWallets,
  creditWallet,
  debitWallet,
  creditPendingSettlement,
  moveToAvailable,
  reserveFunds,
  finalizeReservedDebit,
  releaseReservedFunds,
  reserveFundsWithLedgerEntry,
  creditPendingSettlementWithLedgerEntry,
};
