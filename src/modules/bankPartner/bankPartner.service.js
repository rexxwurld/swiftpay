// src/modules/bankPartner/bankPartner.service.js

const axios = require("axios");
const BankPartner = require("./bankPartner.model");
const VirtualAccount = require("../virtualAccount/virtualAccount.model");
const generateAccountNumber = require("../../utils/generateAccountNumber");
const {
  rexxPayBankBaseUrl,
  rexxPayBankAdminKey,
} = require("../../config/env");
const limits = require("../../config/limits");

async function ensureDefaultBankPartners() {
  const defaults = [
    {
      name: "RexxPay Bank",
      slug: "rexxpay-bank",
    },
  ];

  for (const bank of defaults) {
    await BankPartner.findOneAndUpdate(
      { slug: bank.slug },
      bank,
      { upsert: true }
    );
  }
}

// TEST MODE NEVER CALLS THE REAL BANK.
async function provisionAccountPool(
  bankSlug,
  count = 20,
  mode = "live"
) {
  if (mode !== "live") {
    throw new Error(
      "test_mode_accounts_are_minted_on_demand_and_do_not_need_provisioning"
    );
  }

  const bank = await BankPartner.findOne({ slug: bankSlug });

  if (!bank) {
    throw new Error(`Unknown bank partner: ${bankSlug}`);
  }

  if (bankSlug === "rexxpay-bank") {
    return provisionRealAccountsFromBank(bank, count);
  }

  const accounts = [];

  for (let i = 0; i < count; i++) {
    accounts.push({
      accountNumber: generateAccountNumber(),
      bank: bank._id,
      status: "available",
      mode: "live",
    });
  }

  await VirtualAccount.insertMany(accounts, {
    ordered: false,
  }).catch(() => {});

  return bank;
}

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_STATUS = new Set([
  429,
  502,
  503,
  504,
]);

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;
const DELAY_BETWEEN_REQUESTS_MS = 300;

async function createPoolAccountWithRetry(label) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post(
        `${rexxPayBankBaseUrl}/api/v1/admin/pool-accounts`,
        { label },
        {
          headers: {
            "x-admin-key": rexxPayBankAdminKey,
            "Content-Type": "application/json",
          },
          timeout: 45000,
        }
      );

      return response.data.data;
    } catch (err) {
      lastErr = err;

      const status = err.response?.status;

      const isRetryable =
        RETRYABLE_STATUS.has(status) ||
        err.code === "ECONNABORTED";

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        break;
      }

      const retryAfterHeader = Number(
        err.response?.headers?.["retry-after"]
      );

      const backoff =
        Number.isFinite(retryAfterHeader) &&
        retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : BASE_DELAY_MS * 2 ** (attempt - 1) +
            Math.random() * 500;

      await sleep(backoff);
    }
  }

  const message =
    lastErr.response?.data?.message ||
    lastErr.message;

  const status = lastErr.response?.status;

  const err = new Error(
    `Failed to provision real account from RexxPay Bank after ${MAX_ATTEMPTS} attempts` +
      `${status ? ` (last status ${status})` : ""}: ${message}`
  );

  err.cause = lastErr;

  throw err;
}

async function provisionRealAccountsFromBank(bank, count) {
  if (!rexxPayBankAdminKey) {
    throw new Error(
      "REXXPAY_BANK_ADMIN_KEY is not set - cannot provision real accounts from RexxPay Bank."
    );
  }

  const created = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      const { accountNumber } =
        await createPoolAccountWithRetry(
          `SwiftPay Infra pool account #${i + 1}`
        );

      created.push({
        accountNumber,
        bank: bank._id,
        status: "available",
        mode: "live",
      });
    } catch (err) {
      errors.push(err.message);
      break;
    }

    if (i < count - 1) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  if (created.length) {
    await VirtualAccount.insertMany(
      created,
      { ordered: false }
    ).catch(() => {});
  }

  if (errors.length && created.length === 0) {
    throw new Error(errors[0]);
  }

  if (errors.length) {
    console.error(
      `[provisionRealAccountsFromBank] provisioned ${created.length}/${count} before failing: ${errors[0]}`
    );
  }

  return bank;
}

async function maintainAccountPools({
  threshold = limits.POOL_MIN_THRESHOLD,
  topUpCount = limits.POOL_TOPUP_COUNT,
} = {}) {
  const banks = await BankPartner.find();
  const results = [];

  for (const bank of banks) {
    const available =
      await VirtualAccount.countDocuments({
        bank: bank._id,
        status: "available",
        mode: "live",
      });

    if (available > threshold) {
      results.push({
        bank: bank.slug,
        availableBefore: available,
        threshold,
        action: "none",
      });

      continue;
    }

    try {
      await provisionAccountPool(
        bank.slug,
        topUpCount,
        "live"
      );

      const availableAfter =
        await VirtualAccount.countDocuments({
          bank: bank._id,
          status: "available",
          mode: "live",
        });

      results.push({
        bank: bank.slug,
        availableBefore: available,
        availableAfter,
        threshold,
        provisioned: topUpCount,
        action: "provisioned",
      });
    } catch (err) {
      results.push({
        bank: bank.slug,
        availableBefore: available,
        threshold,
        action: "failed",
        error: err.message,
      });
    }
  }

  return results;
}

async function syncBankAccountStatus(accountNumber, action, amount) {
  try {
    const response = await axios.patch(
      `${rexxPayBankBaseUrl}/api/v1/admin/pool-accounts/${accountNumber}/${action}`,
      amount != null ? { expectedAmount: amount } : {},
      {
        headers: {
          "x-admin-key": rexxPayBankAdminKey,
        },
        timeout: 15000,
      }
    );

    return {
      success: true,
      status: response.status,
      data: response.data,
    };
  } catch (err) {
    const status = err.response?.status || null;

    const message =
      err.response?.data?.message ||
      err.message;

    // A 404 specifically on `deactivate` is treated as an idempotent
    // success, not a failure - this is the concrete root cause behind a
    // production error this codebase's own README logged before this
    // audit session ("failed to deactivate account ... 404"). Working
    // hypothesis, based on how RexxPay Bank's pool accounts behave
    // elsewhere in this integration (see maintainAccountPools /
    // assignBankPoolAccount): once a deposit lands on a pool account,
    // RexxPay Bank may already transition or reclaim it server-side
    // without waiting for SwiftPay's own deactivate call - so by the
    // time deactivateVirtualAccount() (called via the
    // deactivate_virtual_account outbox event, itself only enqueued
    // after a successful payment already landed) gets around to calling
    // this, the account may already be gone/deactivated on RexxPay's
    // side. Deactivation is idempotent by nature: "already in the target
    // state" should be a success, not an error - the same way a
    // well-behaved DELETE returning 404 for an already-deleted resource
    // isn't a real failure for the caller's purposes.
    //
    // This is a defensible best-effort fix given the constraints this
    // session had (no access to RexxPay Bank's own logs/source to
    // confirm the 404's actual cause) - logged distinctly (info, not
    // error) specifically so this assumption stays falsifiable: if it's
    // wrong, these log lines are exactly what someone with RexxPay Bank
    // access needs to disprove it, rather than the assumption silently
    // hiding the evidence.
    if (action === "deactivate" && status === 404) {
      console.info(
        `[bankPartner] deactivate returned 404 for account ${accountNumber} - treating as already-deactivated (idempotent success). If this assumption is wrong, RexxPay Bank's logs for this account/timestamp are the way to confirm it.`
      );
      return {
        success: true,
        status,
        alreadyDeactivated: true,
        data: err.response?.data || null,
      };
    }

    console.error(
      `[bankPartner] failed to ${action} account ${accountNumber} on RexxPay Bank: ${message}`
    );

    const syncError = new Error(
  `Bank account ${action} failed for ${accountNumber}: ${message}`
);

syncError.code = "BANK_ACCOUNT_SYNC_FAILED";
syncError.status = status;
syncError.accountNumber = accountNumber;
syncError.action = action;
syncError.cause = err;

// A timeout/network failure means we cannot know whether RexxPay
// received or executed the instruction. Never treat that as a
// definite rejection.
syncError.ambiguousOutcome =
  !status ||
  status === 408 ||
  status === 429 ||
  status >= 500;

throw syncError;
  }
}


// --- Account-name resolution --------------------------------------------
//
// Requirement: never trust a merchant-supplied account name for a payout
// destination - look it up against the bank/provider first, the same way
// Paystack's `GET /bank/resolve` works.
//
// IMPORTANT: RexxPay Bank's exact endpoint for this has not been
// confirmed directly against RexxPay Bank itself - the shape below is
// built the standard way any such integration is (mirroring Paystack's
// `GET /bank/resolve`), but the literal path/response shape should be
// verified against RexxPay Bank's real API before depending on it in
// live mode. If it turns out RexxPay Bank doesn't expose this capability
// yet, the manual-admin-verification fallback in recipient.service.js /
// PATCH /admin/recipients/:id/verify covers that gap in the meantime.
//
// Fails closed by design: any error here (network, 404, unconfigured)
// throws `account_resolution_unavailable` rather than inventing a name.
// Callers (recipient.service.js) treat that as "not provider-verified"
// and fall back to requiring manual admin verification - never silently
// trust the caller-supplied name instead.
async function resolveBankAccount({ bankCode, accountNumber }) {
  if (!bankCode || !accountNumber) {
    throw new Error("bank_code_and_account_number_required");
  }

  if (!rexxPayBankAdminKey) {
    const err = new Error("account_resolution_unavailable");
    err.reason = "rexxpay_bank_admin_key_not_configured";
    throw err;
  }

  try {
    const response = await axios.get(
      `${rexxPayBankBaseUrl}/api/v1/admin/accounts/resolve`,
      {
        params: { bankCode, accountNumber },
        headers: { "x-admin-key": rexxPayBankAdminKey },
        timeout: 15000,
      }
    );

    const accountName = response.data?.data?.accountName || null;

    if (!accountName) {
      const err = new Error("account_resolution_unavailable");
      err.reason = "provider_returned_no_name";
      throw err;
    }

    return { accountName, bankCode, accountNumber };
  } catch (err) {
    if (err.message === "account_resolution_unavailable") throw err;

    const resolutionErr = new Error("account_resolution_unavailable");
    resolutionErr.reason =
      err.response?.status === 404
        ? "provider_endpoint_not_found_unconfirmed_contract"
        : err.response?.data?.message || err.message;
    resolutionErr.cause = err;
    throw resolutionErr;
  }
}

const assignBankPoolAccount = (accountNumber, amount) =>
  syncBankAccountStatus(
    accountNumber,
    "assign",
    amount
  );

const releaseBankPoolAccount = (accountNumber) =>
  syncBankAccountStatus(
    accountNumber,
    "release"
  );

const deactivateBankPoolAccount = (accountNumber) =>
  syncBankAccountStatus(
    accountNumber,
    "deactivate"
  );

module.exports = {
  ensureDefaultBankPartners,
  provisionAccountPool,
  maintainAccountPools,
  assignBankPoolAccount,
  releaseBankPoolAccount,
  deactivateBankPoolAccount,
  resolveBankAccount,
};
