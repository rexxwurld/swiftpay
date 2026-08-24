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


// =========================================================
// BANK ACCOUNT STATE SYNC
// =========================================================
//
// IMPORTANT:
//
// The BANK is responsible for immediately deactivating a virtual
// account when money enters it.
//
// SwiftPay only calls these endpoints as a fallback.
//
// Therefore:
// - success = bank confirmed the requested action
// - failure = bank did not confirm it
//
// We DO NOT swallow the failure anymore.
// =========================================================





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

    console.error(
      `[bankPartner] failed to ${action} account ${accountNumber} on RexxPay Bank: ${message}`
    );

    return {
      success: false,
      status,
      error: message,
    };
  }
}

const assignBankPoolAccount = (accountNumber) =>
  syncBankAccountStatus(
    accountNumber,
    "assign"
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
};
