// src/modules/bankPartner/rexxPayBankClient.js
const crypto = require('crypto');
const axios = require('axios');
const { rexxPayBankBaseUrl, rexxPayBankPayoutSecret, linkedServiceName } = require('../../config/env');

function signPayload(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha512', rexxPayBankPayoutSecret).update(body).digest('hex');
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendPayoutInstruction({
  idempotencyKey,
  amountMajorUnits,
  destinationAccountNumber,
  destinationBank,
  destinationAccountName,
}) {
  if (!rexxPayBankPayoutSecret) {
    throw new Error('rexxpay_bank_payout_secret_not_configured');
  }

  const payload = {
    idempotencyKey,
    linkedService: linkedServiceName,
    destinationAccountNumber,
    destinationBank,
    destinationAccountName,
    amount: amountMajorUnits,
  };

  const signature = signPayload(payload);
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post(`${rexxPayBankBaseUrl}/api/v1/payouts`, payload, {
        headers: { 'x-swiftpay-signature': signature, 'Content-Type': 'application/json' },
        timeout: 45000,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 402,
      });

      const data = response.data?.data || null;
      const accepted = response.data?.status === true;
      const providerState = data?.status || null;

      return {
        httpStatus: response.status,
        accepted,
        duplicate: !!response.data?.duplicate,
        success: providerState === 'successful',
        final: providerState === 'successful' || providerState === 'failed',
        providerReference: data?.providerRef || data?.providerReference || null,
        failureReason: data?.failureReason || null,
        payout: data,
      };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const isRetryable = RETRYABLE_STATUS.has(status) || err.code === 'ECONNABORTED' || !err.response;

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        break;
      }

      const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
      const backoff = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 300;

      await sleep(backoff);
    }
  }

  const message = lastErr.response?.data?.message || lastErr.message;
  const err = new Error(`rexxpay_bank_payout_call_failed: ${message}`);
  err.cause = lastErr;
  err.ambiguousOutcome = true;
  throw err;
}

// TEST MODE ONLY. Makes NO network call - no real bank, no real money,
// ever. Mirrors the real client's return shape exactly so payout.service.js
// doesn't need to know which one it's talking to. Convention (like
// Stripe/Paystack test cards): a destination account number ending in
// "0000" simulates a bank decline, so integrators can test their failure
// handling without needing a real failure from RexxPay Bank.
async function simulatePayoutInstruction({
  idempotencyKey,
  amountMajorUnits,
  destinationAccountNumber,
}) {
  await sleep(300 + Math.random() * 400); // feels like a real network round-trip

  const simulateDecline = String(destinationAccountNumber || '').endsWith('0000');

  if (simulateDecline) {
    return {
      httpStatus: 402,
      success: false,
      duplicate: false,
      payout: { failureReason: 'simulated_test_mode_decline' },
    };
  }

  return {
    httpStatus: 200,
    accepted: true,
    success: true,
    final: true,
    duplicate: false,
    providerReference: `test_${idempotencyKey}`,
    failureReason: null,
    payout: { providerReference: `test_${idempotencyKey}`, status: 'successful' },
  };
}

// --- Refunds -----------------------------------------------------------
//
// Unlike a payout, a real bank/card-network refund is NEVER confirmed
// synchronously in the same call that submits it - card refunds in
// particular settle over several business days via a batch process on
// the network side, not a live transfer. So this function's job is only
// to ask RexxPay Bank to *accept the refund instruction* - "yes, we've
// received this and will process it" - not to report whether the money
// has actually reached the customer. The real outcome (successful /
// failed) always arrives later via the signed webhook at
// POST /api/v1/webhooks/refunds, handled by refund.webhook.controller.js
// and applied through refund.service.js's confirmRefundOutcome().
async function sendRefundInstruction({
  idempotencyKey,
  amountMajorUnits,
  originalBankReference,
  destinationAccountNumber,
  destinationBank,
  destinationAccountName,
}) {
  if (!rexxPayBankPayoutSecret) {
    throw new Error('rexxpay_bank_payout_secret_not_configured');
  }

  const payload = {
    idempotencyKey,
    linkedService: linkedServiceName,
    originalBankReference,
    destinationAccountNumber,
    destinationBank,
    destinationAccountName,
    amount: amountMajorUnits,
  };

  const signature = signPayload(payload);
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // This endpoint is expected to ack fast (bank queues the refund
      // internally) - short timeout relative to sendPayoutInstruction,
      // since we are NOT waiting for settlement here.
      const response = await axios.post(`${rexxPayBankBaseUrl}/api/v1/refunds`, payload, {
        headers: { 'x-swiftpay-signature': signature, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 402,
      });

      return {
        httpStatus: response.status,
        // accepted: true means "the bank has queued this refund and will
        // confirm the real outcome via webhook" - it is NOT "the refund
        // succeeded".
        accepted: response.data?.status === true,
        duplicate: !!response.data?.duplicate,
        submissionRef: response.data?.data?.submissionRef || null,
        rejectionReason: response.data?.data?.rejectionReason || null,
      };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const isRetryable = RETRYABLE_STATUS.has(status) || err.code === 'ECONNABORTED' || !err.response;

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        break;
      }

      const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
      const backoff = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 300;

      await sleep(backoff);
    }
  }

  const message = lastErr.response?.data?.message || lastErr.message;
  const err = new Error(`rexxpay_bank_refund_submission_failed: ${message}`);
  err.cause = lastErr;
  // Same reasoning as sendPayoutInstruction: if the network call itself
  // is what failed (timeout, connection drop), we genuinely don't know
  // whether RexxPay Bank received and queued the instruction or not.
  err.ambiguousOutcome = true;
  throw err;
}

// TEST MODE ONLY. No network call. Always accepts the submission - the
// simulated *outcome* (success/decline) is delivered later by
// scripts/... or an admin action that fires a fake webhook, the same way
// a real bank would confirm asynchronously. This keeps test mode
// exercising the exact same async confirm path as live mode, instead of
// secretly resolving synchronously the way the old stub did.
async function simulateRefundInstruction({ idempotencyKey }) {
  await sleep(200 + Math.random() * 300);

  return {
    httpStatus: 200,
    accepted: true,
    duplicate: false,
    submissionRef: `test_${idempotencyKey}`,
    rejectionReason: null,
  };
}

module.exports = {
  sendPayoutInstruction,
  simulatePayoutInstruction,
  sendRefundInstruction,
  simulateRefundInstruction,
};
