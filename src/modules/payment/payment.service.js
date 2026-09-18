const crypto = require('crypto');

const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const Transaction = require('../transaction/transaction.model');
const Checkout = require('../checkout/checkout.model');

const { createCustomer } = require('../customer/customer.service');
const { assignVirtualAccount, releaseVirtualAccount } = require('../virtualAccount/virtualAccount.service');
const limits = require('../../config/limits');

function validateRedirectUrl(redirectUrl) {
  if (!redirectUrl) {
    return null;
  }
  let url;
  try {
    url = new URL(redirectUrl);
  } catch {
    throw new Error('invalid_redirect_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('invalid_redirect_url');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('redirect_url_must_be_https');
  }
  return url.toString();
}

async function initializePayment({
  merchantId,
  merchantPlan,
  amount,
  customer,
  tx_ref,
  redirect_url,
  baseUrl,
  mode, // required - no safe default for "which key was this for"
}) {
  if (mode !== 'test' && mode !== 'live') {
    throw new Error('payment_mode_required');
  }

  if (amount === undefined || amount === null || isNaN(amount) || Number(amount) <= 0) {
    throw new Error('amount_required');
  }

  // MINOR UNITS CONTRACT: `amount` here is kobo (NGN's minor unit)
  // directly, exactly like every other money-moving endpoint in this
  // API (payouts, withdrawals, refunds) - NOT naira. This used to
  // multiply the incoming amount by 100 (treating it as major units),
  // which was a direct contract violation: a caller correctly following
  // the documented minor-units contract and sending 100000 (meaning
  // ₦1,000) would have had it silently amplified to ₦100,000. The two
  // human-facing callers that collect a naira amount from a person
  // (public/js/dashboard.js's "create payment link" form, and
  // demo.service.js's startDemoCheckout) now do their own naira->kobo
  // conversion before calling this function, the same way a real
  // integration's own frontend would.
  if (!Number.isInteger(Number(amount))) {
    throw new Error('amount_must_be_integer_minor_units');
  }
  const requestedAmountMinor = Number(amount);
  const { MIN_SINGLE_PAYMENT_MINOR } = limits.getLimitsForMerchant({ plan: merchantPlan });
  if (requestedAmountMinor < MIN_SINGLE_PAYMENT_MINOR) {
    throw new Error('amount_below_minimum');
  }

  if (!customer?.email) {
    throw new Error('customer_email_required');
  }

  const redirectUrl = validateRedirectUrl(redirect_url);

  const reference = tx_ref || `rxp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

  // tx_ref must behave like an idempotency key: the same (merchant, mode,
  // tx_ref) always maps back to the same checkout. Without this check, a
  // merchant reusing a reference (retry, client bug, or two orders sharing
  // an ID) would silently get a second virtual account, and the resulting
  // second bank transfer would be recorded as a "duplicate" of the first
  // and never become its own transaction (see audit report, Critical #8).
  const existingCheckout = await Checkout.findOne({ merchant: merchantId, mode, txRef: reference }).populate({
    path: 'virtualAccount',
    select: 'accountNumber',
  });
  if (existingCheckout) {
    return {
      link: `${baseUrl}/pay/${existingCheckout.token}`,
      tx_ref: existingCheckout.txRef,
      accountNumber: existingCheckout.accountNumber,
      mode: existingCheckout.mode,
    };
  }

  const customerDoc = await createCustomer({
    merchantId,
    fullName: customer.name || customer.email,
    email: customer.email,
    phone: customer.phone || null,
  });

  const amountMinor = requestedAmountMinor;

  let assigned;

  try {
    assigned = await assignVirtualAccount({
      merchantId,
      customerId: customerDoc._id,
      amount: amountMinor,
      reference,
      mode,
    });

    const { account, checkoutToken } = assigned;

    let checkout;
    try {
      checkout = await Checkout.create({
        token: checkoutToken,
        merchant: merchantId,
        customer: customerDoc._id,
        virtualAccount: account._id,
        txRef: reference,
        accountNumber: account.accountNumber,
        bankName: account.bank?.name || null,
        amountExpected: amountMinor,
        redirectUrl,
        mode,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
    } catch (err) {
      if (err.code === 11000) {
        // Lost a race against a concurrent initialize() call for the same
        // (merchant, mode, tx_ref). The virtual account we just assigned
        // is unused - release it back to the pool - and return the
        // checkout that actually won, so the caller still gets a valid
        // link instead of an error.
        const raced = await Checkout.findOne({ merchant: merchantId, mode, txRef: reference });
        if (raced) {
          await releaseVirtualAccount(account._id).catch(() => {});
          return {
            link: `${baseUrl}/pay/${raced.token}`,
            tx_ref: raced.txRef,
            accountNumber: raced.accountNumber,
            mode: raced.mode,
          };
        }
      }
      throw err;
    }

    const link = `${baseUrl}/pay/${checkout.token}`;

    return {
      link,
      tx_ref: reference,
      accountNumber: account.accountNumber,
      mode,
    };
  } catch (err) {
    if (assigned?.account?._id) {
      await releaseVirtualAccount(assigned.account._id).catch(() => {});
    }
    throw err;
  }
}

async function verifyPayment({ merchantId, tx_ref }) {
  const account = await VirtualAccount.findOne({ merchant: merchantId, reference: tx_ref });

  let transaction = null;

  if (account) {
    transaction = await Transaction.findOne({ virtualAccount: account._id }).sort({ createdAt: -1 });
  } else {
    transaction = await Transaction.findOne({ merchant: merchantId, reference: tx_ref }).sort({ createdAt: -1 });
  }

  if (!account && !transaction) {
    throw new Error('transaction_not_found');
  }

  return {
    tx_ref,
    status: transaction?.status || 'pending',
    amountExpected: account?.amountExpected ?? transaction?.amountExpected ?? null,
    amountReceived: transaction?.amountReceived ?? null,
    accountNumber: account?.accountNumber ?? null,
    mode: transaction?.mode ?? account?.mode ?? null,
  };
}

module.exports = { initializePayment, verifyPayment };
