// tests/integration/concurrentFinancialRequests.test.js
//
// Regression tests for concurrent payout/withdrawal/refund requests -
// one of the explicitly-flagged missing test categories from the audit
// report's Testing Audit section. Each covers a genuine race fired via
// Promise.all against a real (in-memory) MongoDB replica set, not a
// mocked model - the guarantees here (unique idempotency-key index,
// atomic compare-and-increment refund headroom) only actually prove
// anything under real multi-document transaction/write-conflict
// semantics.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant, Payout, Withdrawal, Refund, Transaction, Customer, VirtualAccount, BankPartner;
let requestPayout, requestWithdrawal, requestRefund;
let postDoubleEntry;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Payout = require('../../src/modules/payout/payout.model');
  Withdrawal = require('../../src/modules/withdrawal/withdrawal.model');
  Refund = require('../../src/modules/refund/refund.model');
  Transaction = require('../../src/modules/transaction/transaction.model');
  Customer = require('../../src/modules/customer/customer.model');
  VirtualAccount = require('../../src/modules/virtualAccount/virtualAccount.model');
  BankPartner = require('../../src/modules/bankPartner/bankPartner.model');

  ({ requestPayout } = require('../../src/modules/payout/payout.service'));
  ({ requestWithdrawal } = require('../../src/modules/withdrawal/withdrawal.service'));
  ({ requestRefund } = require('../../src/modules/refund/refund.service'));
  ({ postDoubleEntry } = require('../../src/modules/ledger/ledger.service'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

async function makeMerchant(overrides = {}) {
  const suffix = new mongoose.Types.ObjectId().toString();
  return Merchant.create({
    businessName: 'Test Merchant',
    email: `merchant_${suffix}@example.com`,
    passwordHash: 'not_a_real_hash',
    testPublicKey: `pk_test_${suffix}`,
    testSecretKeyHash: `hash_test_${suffix}`,
    livePublicKey: `pk_live_${suffix}`,
    liveSecretKeyHash: `hash_live_${suffix}`,
    isVerified: true,
    ...overrides,
  });
}

async function fundWallet(merchantId, amount, { currency = 'NGN', mode = 'test' } = {}) {
  const Wallet = require('../../src/modules/wallet/wallet.model');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await postDoubleEntry({
        entryGroup: `test_fund_${new mongoose.Types.ObjectId()}`,
        amount,
        currency,
        mode,
        sourceType: 'adjustment',
        sourceRef: new mongoose.Types.ObjectId().toString(),
        debit: { accountType: 'suspense', accountRef: 'test_funding_source', description: 'test fixture' },
        credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'test fixture' },
        session,
      });
      await Wallet.findOneAndUpdate(
        { merchant: merchantId, currency, mode },
        { $inc: { balance: amount } },
        { upsert: true, new: true, session }
      );
    });
  } finally {
    session.endSession();
  }
}

describe('concurrent payout requests', () => {
  it('two concurrent requests with the same idempotency key create exactly one payout', async () => {
    const merchant = await makeMerchant();
    await fundWallet(merchant._id, 1_000_000);

    const args = {
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'concurrent-payout-key-1',
      destinationBankCode: '044',
      destinationAccountNumber: '0123456789',
      destinationAccountName: 'Recipient Name',
    };

    const [a, b] = await Promise.all([requestPayout({ ...args }), requestPayout({ ...args })]);

    expect(a._id.toString()).toBe(b._id.toString());

    const allPayouts = await Payout.find({ merchant: merchant._id, idempotencyKey: 'concurrent-payout-key-1' });
    expect(allPayouts).toHaveLength(1);
  });

  it('two concurrent requests with the same key but DIFFERENT amounts reject the mismatch, and never create two payouts', async () => {
    const merchant = await makeMerchant();
    await fundWallet(merchant._id, 1_000_000);

    const base = {
      merchantId: merchant._id,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'concurrent-payout-key-mismatch',
      destinationBankCode: '044',
      destinationAccountNumber: '0123456789',
      destinationAccountName: 'Recipient Name',
    };

    const results = await Promise.allSettled([
      requestPayout({ ...base, amount: 100_000 }),
      requestPayout({ ...base, amount: 250_000 }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one wins (creates the payout); the other is rejected for
    // reusing the same key with a different request, NOT silently
    // treated as "the same retry".
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('idempotency_key_reused_with_different_request');

    const allPayouts = await Payout.find({ merchant: merchant._id, idempotencyKey: 'concurrent-payout-key-mismatch' });
    expect(allPayouts).toHaveLength(1);
  });
});

describe('concurrent withdrawal requests', () => {
  it('two concurrent requests with the same idempotency key create exactly one withdrawal', async () => {
    const merchant = await makeMerchant({
      settlementAccount: {
        bankCode: '044',
        accountNumber: '0123456789',
        accountName: 'Test Merchant Ltd',
        verified: true,
      },
    });
    await fundWallet(merchant._id, 1_000_000);

    const args = {
      merchantId: merchant._id,
      amount: 100_000,
      currency: 'NGN',
      mode: 'test',
      idempotencyKey: 'concurrent-withdrawal-key-1',
    };

    const [a, b] = await Promise.all([requestWithdrawal({ ...args }), requestWithdrawal({ ...args })]);

    expect(a._id.toString()).toBe(b._id.toString());

    const allWithdrawals = await Withdrawal.find({ merchant: merchant._id, idempotencyKey: 'concurrent-withdrawal-key-1' });
    expect(allWithdrawals).toHaveLength(1);
  });
});

describe('concurrent refund requests', () => {
  async function makeRefundableTransaction(merchant, amountReceived = 200_000) {
    const bank = await BankPartner.create({
      name: `Bank ${new mongoose.Types.ObjectId()}`,
      slug: `bank-${new mongoose.Types.ObjectId()}`,
    });
    const customer = await Customer.create({
      merchant: merchant._id,
      fullName: 'Jane Doe',
      email: `jane_${new mongoose.Types.ObjectId()}@example.com`,
    });
    const virtualAccount = await VirtualAccount.create({
      accountNumber: `90${new mongoose.Types.ObjectId().toString().slice(0, 8)}`,
      bank: bank._id,
      merchant: merchant._id,
      customer: customer._id,
      mode: 'test',
      status: 'deactivated',
    });
    const transaction = await Transaction.create({
      reference: `txref_${new mongoose.Types.ObjectId()}`,
      merchant: merchant._id,
      customer: customer._id,
      virtualAccount: virtualAccount._id,
      mode: 'test',
      status: 'success',
      amountReceived,
      currency: 'NGN',
      bankReference: `bankref_${new mongoose.Types.ObjectId()}`,
    });

    // The merchant's wallet needs to actually hold the money for
    // debitWallet() (called inside requestRefund) to succeed.
    await fundWallet(merchant._id, amountReceived);

    return transaction;
  }

  it('two concurrent requests with the same idempotency key create exactly one refund', async () => {
    const merchant = await makeMerchant();
    const transaction = await makeRefundableTransaction(merchant, 200_000);

    const args = {
      merchantId: merchant._id,
      transactionId: transaction._id,
      amount: 50_000,
      reason: 'duplicate charge',
      destinationBankCode: '044',
      destinationAccountNumber: '0123456789',
      destinationAccountName: 'Jane Doe',
      idempotencyKey: 'concurrent-refund-key-1',
    };

    const [a, b] = await Promise.all([requestRefund({ ...args }), requestRefund({ ...args })]);

    expect(a._id.toString()).toBe(b._id.toString());

    const allRefunds = await Refund.find({ merchant: merchant._id, idempotencyKey: 'concurrent-refund-key-1' });
    expect(allRefunds).toHaveLength(1);

    const updatedTransaction = await Transaction.findById(transaction._id);
    expect(updatedTransaction.refundedAmount).toBe(50_000); // claimed ONCE, not twice
  });

  it('two concurrent full-amount refund requests (different idempotency keys) cannot both succeed - the loser gets refund_exceeds_refundable_amount', async () => {
    const merchant = await makeMerchant();
    const transaction = await makeRefundableTransaction(merchant, 100_000);

    const base = {
      merchantId: merchant._id,
      transactionId: transaction._id,
      amount: 100_000, // the FULL amount - two of these together would be 200,000 against a 100,000 transaction
      reason: 'test',
      destinationBankCode: '044',
      destinationAccountNumber: '0123456789',
      destinationAccountName: 'Jane Doe',
    };

    const results = await Promise.allSettled([
      requestRefund({ ...base, idempotencyKey: 'concurrent-refund-race-a' }),
      requestRefund({ ...base, idempotencyKey: 'concurrent-refund-race-b' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // The atomic compare-and-increment on refundedAmount means only ONE
    // of these two genuinely-different requests can claim the
    // refundable headroom, regardless of idempotency keys being
    // different (this is a DIFFERENT guard than idempotency - it's
    // protecting against over-refunding the underlying transaction).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('refund_exceeds_refundable_amount');

    const updatedTransaction = await Transaction.findById(transaction._id);
    expect(updatedTransaction.refundedAmount).toBe(100_000); // not 200,000
  });
});
