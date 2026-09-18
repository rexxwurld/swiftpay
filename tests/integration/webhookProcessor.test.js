// tests/integration/webhookProcessor.test.js
//
// Direct coverage of processEvent() in webhook.processor.js - previously
// untested (only signature verification had its own test file). Bypasses
// enqueue()/the Redis-backed BullMQ queue entirely by inserting the
// WebhookEvent document directly and calling processEvent(id), since
// this sandbox has no Redis available and processEvent() is what the
// real worker calls after dequeuing anyway - the queue itself is just
// transport.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant, Customer, VirtualAccount, BankPartner, WebhookEvent, Transaction;
let processEvent;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Customer = require('../../src/modules/customer/customer.model');
  VirtualAccount = require('../../src/modules/virtualAccount/virtualAccount.model');
  BankPartner = require('../../src/modules/bankPartner/bankPartner.model');
  WebhookEvent = require('../../src/modules/webhook/webhookEvent.model');
  Transaction = require('../../src/modules/transaction/transaction.model');

  ({ processEvent } = require('../../src/modules/webhook/webhook.processor'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

async function makeFixture() {
  const suffix = new mongoose.Types.ObjectId().toString();

  const merchant = await Merchant.create({
    businessName: 'Test Merchant',
    email: `merchant_${suffix}@example.com`,
    passwordHash: 'not_a_real_hash',
    testPublicKey: `pk_test_${suffix}`,
    testSecretKeyHash: `hash_test_${suffix}`,
    livePublicKey: `pk_live_${suffix}`,
    liveSecretKeyHash: `hash_live_${suffix}`,
    isVerified: true,
  });

  const bank = await BankPartner.create({ name: `Test Bank ${suffix}`, slug: `test-bank-${suffix}` });

  const customer = await Customer.create({
    merchant: merchant._id,
    fullName: 'Regular Customer',
    email: `customer_${suffix}@example.com`,
  });

  const virtualAccount = await VirtualAccount.create({
    accountNumber: `90${suffix.slice(0, 8)}`,
    bank: bank._id,
    merchant: merchant._id,
    customer: customer._id,
    mode: 'test',
    status: 'assigned',
    assignedAt: new Date(),
    amountExpected: 100_000,
    reference: `ORDER-${suffix}`,
  });

  return { merchant, customer, virtualAccount };
}

async function createQueuedEvent(rawBody, providerEventId) {
  return WebhookEvent.create({
    source: 'bank_partner',
    providerEventId,
    rawBody,
    signature: 'test-signature',
    status: 'queued',
  });
}

describe('webhook.processor.processEvent', () => {
  it('fails closed on an unrecognized account number without creating a transaction', async () => {
    const event = await createQueuedEvent(
      { accountNumber: 'does-not-exist', amountReceived: 100_000, currency: 'NGN', bankReference: 'bref-1' },
      'evt-unrecognized-1'
    );

    await processEvent(event._id);

    const updated = await WebhookEvent.findById(event._id);
    expect(updated.status).toBe('failed');
    expect(updated.lastError).toBe('unrecognized_or_inactive_account');
    expect(await Transaction.countDocuments({})).toBe(0);
  });

  it('fails closed on a currency other than NGN rather than defaulting past it', async () => {
    const { virtualAccount } = await makeFixture();

    const event = await createQueuedEvent(
      {
        accountNumber: virtualAccount.accountNumber,
        amountReceived: 100_000,
        currency: 'USD',
        bankReference: 'bref-2',
      },
      'evt-bad-currency-1'
    );

    await processEvent(event._id);

    const updated = await WebhookEvent.findById(event._id);
    expect(updated.status).toBe('failed');
    expect(updated.lastError).toBe('unexpected_currency:USD');
    expect(await Transaction.countDocuments({})).toBe(0);
  });

  it('matches a recognized account and records a successful transaction', async () => {
    const { virtualAccount, merchant } = await makeFixture();

    const event = await createQueuedEvent(
      {
        accountNumber: virtualAccount.accountNumber,
        amountReceived: 100_000,
        currency: 'NGN',
        bankReference: 'bref-3',
      },
      'evt-match-1'
    );

    await processEvent(event._id);

    const updated = await WebhookEvent.findById(event._id);
    expect(updated.status).toBe('processed');

    const transaction = await Transaction.findOne({ bankReference: 'bref-3' });
    expect(transaction).not.toBeNull();
    expect(transaction.status).toBe('success');
    expect(transaction.merchant.toString()).toBe(merchant._id.toString());
    expect(transaction.amountReceived).toBe(100_000);
  });
});
