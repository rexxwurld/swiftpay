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

  const requestedAmountMinor = Math.round(Number(amount) * 100);
  const { MIN_SINGLE_PAYMENT_MINOR } = limits.getLimitsForMerchant({ plan: merchantPlan });
  if (requestedAmountMinor < MIN_SINGLE_PAYMENT_MINOR) {
    throw new Error('amount_below_minimum');
  }

  if (!customer?.email) {
    throw new Error('customer_email_required');
  }

  const redirectUrl = validateRedirectUrl(redirect_url);

  const reference = tx_ref || `rxp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

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

    await Checkout.create({
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

    const link = `${baseUrl}/pay/${checkoutToken}`;

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
