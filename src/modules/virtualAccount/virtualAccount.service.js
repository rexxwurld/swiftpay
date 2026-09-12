const crypto = require('crypto');

const VirtualAccount = require('./virtualAccount.model');
const BankPartner = require('../bankPartner/bankPartner.model');
const Customer = require('../customer/customer.model');
const { provisionAccountPool, assignBankPoolAccount, deactivateBankPoolAccount, releaseBankPoolAccount } = require('../bankPartner/bankPartner.service');
const { findActiveByCodeForMerchant } = require('../subaccount/subaccount.service');
const generateAccountNumber = require('../../utils/generateAccountNumber');

const ACCOUNT_COOLDOWN_MINUTES = 60;

// Test-mode accounts are fake numbers with no real bank behind them, so
// there's no reason to make callers contend over a finite pool the way
// live accounts must. Instead of pulling from `status: 'available'`,
// every test-mode assignment mints a brand-new, disposable account
// number on the spot - unlimited, instantly available, and immune to
// pool exhaustion under concurrent load. This mirrors how Paystack /
// Flutterwave test-mode dedicated virtual accounts behave: unique per
// request, never shared, never contended.
//
// Uniqueness is enforced at the DB level (accountNumber has a unique
// index) - on the astronomically unlikely chance of a random collision,
// this just retries with a new random number.
async function mintTestVirtualAccount({ bank }) {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await VirtualAccount.create({
        accountNumber: generateAccountNumber(),
        bank: bank._id,
        mode: 'test',
        status: 'available', // caller immediately overwrites this to 'assigned'
      });
    } catch (err) {
      if (err.code === 11000 && attempt < MAX_ATTEMPTS - 1) {
        continue; // duplicate accountNumber, extremely unlikely - retry
      }
      throw err;
    }
  }

  throw new Error('failed_to_generate_unique_test_account_number');
}

function generateCheckoutToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Reads mode off the account itself, defaulting historical (pre-field)
// docs to 'live' since that's what they always were.
function isLive(account) {
  return (account.mode || 'live') === 'live';
}

async function assignVirtualAccount({
  merchantId,
  customerId,
  preferredBankSlug,
  amount,
  reference,
  subaccountCode,
  splitPercentage,
  mode = 'test', // fail-safe default: fake accounts, never the real bank
}) {
  const resolvedMode = mode === 'live' ? 'live' : 'test';

  const customer = await Customer.findOne({ _id: customerId, merchant: merchantId });
  if (!customer) {
    throw new Error('customer_not_found');
  }

  if (amount != null && (!Number.isInteger(amount) || amount <= 0)) {
    throw new Error('amount_must_be_a_positive_integer_in_minor_units');
  }

  let splitSubaccount = null;
  let resolvedSplitPercentage = null;

  if (subaccountCode) {
    const subaccount = await findActiveByCodeForMerchant(merchantId, subaccountCode);
    if (!subaccount) {
      throw new Error('unknown_or_inactive_subaccount');
    }
    resolvedSplitPercentage = splitPercentage ?? subaccount.defaultSplitPercentage;
    if (!Number.isFinite(resolvedSplitPercentage) || resolvedSplitPercentage <= 0 || resolvedSplitPercentage > 100) {
      throw new Error('invalid_split_percentage');
    }
    splitSubaccount = subaccount._id;
  }

  let bankFilter = {};
  let preferredBank = null;
  if (preferredBankSlug) {
    preferredBank = await BankPartner.findOne({ slug: preferredBankSlug });
    if (!preferredBank) {
      throw new Error('unknown_bank_partner');
    }
    bankFilter = { bank: preferredBank._id };
  }

  const checkoutToken = generateCheckoutToken();

  const assignment = {
    status: 'assigned',
    merchant: merchantId,
    customer: customerId,
    assignedAt: new Date(),
    deactivatedAt: null,
    cooldownUntil: null,
    amountExpected: amount ?? null,
    reference: reference ?? null,
    splitSubaccount,
    splitPercentage: resolvedSplitPercentage,
  };

  let account;

  if (resolvedMode === 'test') {
    // No pool, no contention: mint a fresh disposable test account and
    // assign it in the same step. Never runs out, never waits on a
    // top-up, never collides with another concurrent test checkout.
    const bank = preferredBank || (await BankPartner.findOne({ slug: 'rexxpay-bank' }));
    if (!bank) {
      throw new Error('unknown_bank_partner');
    }

    account = await mintTestVirtualAccount({ bank });
    Object.assign(account, assignment);
    await account.save();
    await account.populate('bank');
  } else {
    // Live accounts are real bank-backed resources, so they still come
    // from the finite, pre-provisioned pool.
    account = await VirtualAccount.findOneAndUpdate(
      { status: 'available', mode: resolvedMode, ...bankFilter },
      assignment,
      { new: true }
    ).populate('bank');

    if (!account) {
      const bankSlug = preferredBankSlug || 'rexxpay-bank';
      await provisionAccountPool(bankSlug, 20, resolvedMode);

      account = await VirtualAccount.findOneAndUpdate(
        { status: 'available', mode: resolvedMode, ...bankFilter },
        assignment,
        { new: true }
      ).populate('bank');
    }

    if (!account) {
      throw new Error('no_accounts_available');
    }
  }

  

  
  // Only tell the REAL bank about assignment if this is a real account.
// Test-mode accounts never make a network call to RexxPay Bank at all.
if (isLive(account)) {
  try {
    await assignBankPoolAccount(
      account.accountNumber,
      account.amountExpected
    );

    account.bankSyncStatus = 'synced';
    await account.save();
  } catch (err) {
    if (err.ambiguousOutcome) {
      // RexxPay may have received the assignment even though
      // SwiftPay did not receive a definitive response.
      //
      // NEVER return this account to the available pool.
      // It must remain quarantined until reconciliation resolves
      // the bank state.
      account.bankSyncStatus = 'ambiguous';
      await account.save();

      throw new Error('bank_account_assignment_ambiguous');
    }

    // Definite bank rejection: the account was never successfully
    // assigned at the bank, so it is safe to return it to the pool.
    account.status = 'available';
    account.bankSyncStatus = 'failed';
    account.merchant = null;
    account.customer = null;
    account.assignedAt = null;
    account.amountExpected = null;
    account.reference = null;
    account.splitSubaccount = null;
    account.splitPercentage = null;

    await account.save();

    throw new Error('bank_account_assignment_failed');
  }
}
customer.virtualAccount = account._id;
  await customer.save();
return { account, checkoutToken };
}

async function releaseVirtualAccount(accountId) {
  const account = await VirtualAccount.findById(accountId);
  if (!account) {
    return null;
  }

  if (account.status !== 'assigned') {
    return account;
  }

  const now = new Date();
  const cooldownUntil = new Date(
    now.getTime() + ACCOUNT_COOLDOWN_MINUTES * 60 * 1000
  );

  // Test-mode accounts have no real bank state to synchronize.
  if (!isLive(account)) {
    account.status = 'deactivated';
    account.deactivatedAt = now;
    account.cooldownUntil = cooldownUntil;
    account.merchant = null;
    account.customer = null;
    account.assignedAt = null;
    account.amountExpected = null;
    account.reference = null;
    account.splitSubaccount = null;
    account.splitPercentage = null;
    account.bankSyncStatus = 'synced';

    await account.save();

    await Customer.updateOne(
      { virtualAccount: account._id },
      { virtualAccount: null }
    );

    return account;
  }

  // Live account: synchronize with RexxPay BEFORE making the
  // local account available for reuse.
  try {
    await deactivateBankPoolAccount(account.accountNumber);
  } catch (err) {
    if (err.ambiguousOutcome) {
      account.bankSyncStatus = 'ambiguous';
      await account.save();

      throw new Error('bank_account_deactivation_ambiguous');
    }

    account.bankSyncStatus = 'failed';
    await account.save();

    throw new Error('bank_account_deactivation_failed');
  }

  // RexxPay confirmed the deactivation, so it is now safe to
  // finalize the local state.
  account.status = 'deactivated';
  account.deactivatedAt = now;
  account.cooldownUntil = cooldownUntil;
  account.merchant = null;
  account.customer = null;
  account.assignedAt = null;
  account.amountExpected = null;
  account.reference = null;
  account.splitSubaccount = null;
  account.splitPercentage = null;
  account.bankSyncStatus = 'synced';

  await account.save();

  await Customer.updateOne(
    { virtualAccount: account._id },
    { virtualAccount: null }
  );

  return account;
}

async function releaseStaleAssignedAccounts(maxAgeMinutes) {
  const cutoff = new Date(
    Date.now() - maxAgeMinutes * 60 * 1000
  );

  const stale = await VirtualAccount.find({
    status: 'assigned',
    assignedAt: { $lte: cutoff },
  });

  let released = 0;

  for (const account of stale) {
    // Live accounts must be released at RexxPay first.
    // We do NOT make them available locally until the bank confirms.
    if (isLive(account)) {
      try {
        await releaseBankPoolAccount(account.accountNumber);
      } catch (err) {
        if (err.ambiguousOutcome) {
          // RexxPay may have received the release request.
          // Keep the account quarantined until reconciliation resolves it.
          account.bankSyncStatus = 'ambiguous';
        } else {
          // Definite failure: the bank still considers the account assigned.
          account.bankSyncStatus = 'failed';
        }

        await account.save();
        continue;
      }
    }

    // The bank release succeeded (or this is a test account),
    // so it is now safe to return the account to the pool.
    account.status = 'available';
    account.merchant = null;
    account.customer = null;
    account.assignedAt = null;
    account.deactivatedAt = null;
    account.cooldownUntil = null;
    account.amountExpected = null;
    account.reference = null;
    account.splitSubaccount = null;
    account.splitPercentage = null;
    account.bankSyncStatus = 'synced';

    await account.save();

    await Customer.updateOne(
      { virtualAccount: account._id },
      { virtualAccount: null }
    );

    released += 1;
  }

  return released;
}

async function reactivateExpiredAccounts() {
  const now = new Date();

  const accounts = await VirtualAccount.find({
    status: 'deactivated',
    cooldownUntil: { $ne: null, $lte: now },
  });

  let reactivated = 0;

  for (const account of accounts) {
    if (
      account.status !== 'deactivated' ||
      !account.cooldownUntil ||
      account.cooldownUntil > now
    ) {
      continue;
    }

    // Test-mode accounts have no real bank state to synchronize.
    if (!isLive(account)) {
      account.status = 'available';
      account.deactivatedAt = null;
      account.cooldownUntil = null;
      account.merchant = null;
      account.customer = null;
      account.assignedAt = null;
      account.amountExpected = null;
      account.reference = null;
      account.splitSubaccount = null;
      account.splitPercentage = null;
      account.bankSyncStatus = 'synced';

      await account.save();

      reactivated += 1;
      continue;
    }

    // Live account: RexxPay must confirm the account is released
    // before SwiftPay makes it available for another assignment.
    try {
      await releaseBankPoolAccount(account.accountNumber);
    } catch (err) {
      if (err.ambiguousOutcome) {
        // We do not know whether RexxPay processed the release.
        // Keep the account unavailable until reconciliation resolves it.
        account.bankSyncStatus = 'ambiguous';
      } else {
        // Definite failure: RexxPay still considers the account assigned.
        account.bankSyncStatus = 'failed';
      }

      await account.save();
      continue;
    }

    // RexxPay confirmed the release, so it is safe to make the
    // account available in SwiftPay.
    account.status = 'available';
    account.deactivatedAt = null;
    account.cooldownUntil = null;
    account.merchant = null;
    account.customer = null;
    account.assignedAt = null;
    account.amountExpected = null;
    account.reference = null;
    account.splitSubaccount = null;
    account.splitPercentage = null;
    account.bankSyncStatus = 'synced';

    await account.save();

    reactivated += 1;
  }

  return reactivated;
}
async function deactivateVirtualAccount({ merchantId, accountNumber }) {
  const account = await VirtualAccount.findOne({
    accountNumber,
    merchant: merchantId,
  });

  if (!account) {
    throw new Error('account_not_found');
  }

  // Test-mode accounts have no real bank state to synchronize.
  if (!isLive(account)) {
    account.status = 'deactivated';
    account.deactivatedAt = new Date();
    account.cooldownUntil = null;
    account.bankSyncStatus = 'synced';

    await account.save();

    await Customer.updateOne(
      { virtualAccount: account._id },
      { virtualAccount: null }
    );

    return account;
  }

  // Live account: deactivate it at RexxPay first.
  try {
    await deactivateBankPoolAccount(account.accountNumber);
  } catch (err) {
    if (err.ambiguousOutcome) {
      // RexxPay may have received the instruction, but SwiftPay
      // cannot prove the final state.
      account.bankSyncStatus = 'ambiguous';
    } else {
      // Definite failure: keep the local account assigned because
      // the bank may still consider it active.
      account.bankSyncStatus = 'failed';
    }

    await account.save();

    throw new Error(
      err.ambiguousOutcome
        ? 'bank_account_deactivation_ambiguous'
        : 'bank_account_deactivation_failed'
    );
  }

  // RexxPay confirmed the deactivation.
  account.status = 'deactivated';
  account.deactivatedAt = new Date();
  account.cooldownUntil = null;
  account.bankSyncStatus = 'synced';

  await account.save();

  await Customer.updateOne(
    { virtualAccount: account._id },
    { virtualAccount: null }
  );

  return account;
}

async function findByAccountNumber(accountNumber) {
  return VirtualAccount.findOne({ accountNumber }).populate('bank merchant customer');
}

async function findByReference(reference) {
  return VirtualAccount.findOne({ reference }).populate('bank merchant customer');
}

module.exports = {
  assignVirtualAccount,
  deactivateVirtualAccount,
  findByAccountNumber,
  findByReference,
  releaseVirtualAccount,
  releaseStaleAssignedAccounts,
  reactivateExpiredAccounts,
};
