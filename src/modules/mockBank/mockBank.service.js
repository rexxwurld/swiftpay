// src/modules/mockBank/mockBank.service.js
//
// Dev/test tool referenced in the README ("Mock bank partner") but never
// actually wired up: test-mode virtual accounts are fake account numbers
// that no real bank will ever send a webhook for, so without this there
// was no way to ever move a test checkout past "Waiting for your
// transfer...".
//
// Design choice: this does NOT duplicate the payment-success business
// logic (risk checks, ledger postings, merchant webhook dispatch,
// account deactivation, invoice reconciliation, etc). Instead it builds
// the exact payload a real bank partner would send, HMAC-signs it with
// the SAME secret webhook.controller verifies against, and feeds it into
// the SAME webhook.processor pipeline every real payment goes through.
// That means: (a) test payments are processed by the one code path this
// codebase already trusts, so there's nothing new to get wrong, and
// (b) if the real success logic changes later, this keeps working with
// zero changes here.
//
// The only real safety rule lives here: this function will NEVER mark a
// 'live' account as paid. That's checked directly against the account
// document (the single source of truth for real-vs-fake money), not
// against how the caller reached this function.

const crypto = require('crypto');

const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const Transaction = require('../transaction/transaction.model');
const WebhookEvent = require('../webhook/webhookEvent.model');
const { processEvent } = require('../webhook/webhook.processor');
const { signPayload } = require('../../utils/webhookSignature');

async function simulateBankTransfer({ accountNumber, amount, merchantId }) {
  if (!accountNumber) {
    throw new Error('account_number_required');
  }

  const account = await VirtualAccount.findOne({ accountNumber });

  // Don't distinguish "doesn't exist" from "exists but isn't yours" -
  // that would let a caller probe for other merchants' account numbers.
  if (!account || (merchantId && String(account.merchant) !== String(merchantId))) {
    throw new Error('account_not_found');
  }

  if ((account.mode || 'live') !== 'test') {
    throw new Error('simulate_transfer_only_allowed_on_test_mode_accounts');
  }

  if (account.status !== 'assigned') {
    throw new Error('account_is_not_currently_awaiting_a_payment');
  }

  const amountReceived = amount != null ? amount : account.amountExpected;

  if (!Number.isInteger(amountReceived) || amountReceived <= 0) {
    throw new Error('amount_must_be_a_positive_integer_in_minor_units');
  }

  const bankReference = `sim_${crypto.randomBytes(10).toString('hex')}`;

  const rawBody = {
    accountNumber,
    amountReceived,
    currency: 'NGN',
    bankReference,
  };

  // Self-signed with the real bank-webhook secret, exactly like a real
  // RexxPay Bank delivery would be - this is what makes it safe to run
  // this straight through webhook.processor instead of a parallel path.
  const signature = signPayload(rawBody);

  const event = await WebhookEvent.create({
    source: 'mock_bank_partner',
    rawBody,
    signature,
    status: 'queued',
  });

  // Awaited (unlike the real /webhooks/bank receiver, which acks fast
  // and processes async) so the caller can show a result immediately -
  // there's no real bank on the other end that needs a fast 2xx here.
  await processEvent(event._id);

  const [processedEvent, transaction] = await Promise.all([
    WebhookEvent.findById(event._id),
    Transaction.findOne({ reference: bankReference }),
  ]);

  return { event: processedEvent, transaction, bankReference };
}

module.exports = { simulateBankTransfer };
