// tests/integration/outbox.test.js
//
// Regression tests for the transactional-outbox pattern (audit report,
// item 8) and the specific crash scenarios it exists to survive:
//   - DB commit succeeds, but the worker that would act on it never runs
//     (or runs late) - covered by "enqueues atomically" + "tick() processes
//     due events" below.
//   - A duplicate webhook delivery for the same bank event - covered by
//     "does not double-enqueue".
//   - A worker that crashes mid-processing (leaving events stuck
//     'processing') - covered by "recovers stuck-processing events".
//   - A handler that fails transiently vs permanently - covered by the
//     two "retry" tests.

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant, Customer, VirtualAccount, BankPartner, OutboxEvent, Transaction;
let recordIncomingPayment;
let claimBatch, markCompleted, markFailed, redriveStuckProcessing;
let tick;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  Customer = require('../../src/modules/customer/customer.model');
  VirtualAccount = require('../../src/modules/virtualAccount/virtualAccount.model');
  BankPartner = require('../../src/modules/bankPartner/bankPartner.model');
  OutboxEvent = require('../../src/modules/outbox/outboxEvent.model');
  Transaction = require('../../src/modules/transaction/transaction.model');

  ({ recordIncomingPayment } = require('../../src/modules/transaction/transaction.service'));
  ({ claimBatch, markCompleted, markFailed, redriveStuckProcessing } = require('../../src/modules/outbox/outbox.service'));
  ({ tick } = require('../../src/queue/outboxWorker'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

async function makeFixtures() {
  const suffix = new mongoose.Types.ObjectId().toString();
  const merchant = await Merchant.create({
    businessName: 'Test Merchant',
    email: `merchant_${suffix}@example.com`,
    passwordHash: 'not_a_real_hash',
    testPublicKey: `pk_test_${suffix}`,
    testSecretKeyHash: `hash_test_${suffix}`,
    livePublicKey: `pk_live_${suffix}`,
    liveSecretKeyHash: `hash_live_${suffix}`,
  });

  const bank = await BankPartner.create({ name: `Test Bank ${suffix}`, slug: `test-bank-${suffix}` });

  const customer = await Customer.create({
    merchant: merchant._id,
    fullName: 'Jane Doe',
    email: `jane_${suffix}@example.com`,
  });

  const virtualAccount = await VirtualAccount.create({
    accountNumber: `90${suffix.slice(0, 8)}`,
    bank: bank._id,
    merchant: merchant._id,
    customer: customer._id,
    mode: 'test',
    status: 'assigned',
    amountExpected: 100_000,
    reference: `txref_${suffix}`,
  });

  return { merchant, bank, customer, virtualAccount };
}

describe('transactional outbox', () => {
  it('enqueues post-payment outbox events atomically with the financial commit', async () => {
    const { merchant, customer, virtualAccount } = await makeFixtures();

    const { transaction, duplicate } = await recordIncomingPayment({
      reference: virtualAccount.reference,
      merchantId: merchant._id,
      customerId: customer._id,
      virtualAccountId: virtualAccount._id,
      amountReceived: 100_000,
      amountExpected: 100_000,
      currency: 'NGN',
      bankReference: `bankref_${new mongoose.Types.ObjectId()}`,
    });

    expect(duplicate).toBe(false);
    expect(transaction.status).toBe('success');

    const events = await OutboxEvent.find({ sourceType: 'transaction', sourceRef: transaction._id.toString() }).sort({ eventType: 1 });
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual(['deactivate_virtual_account', 'dispatch_merchant_webhook', 'mark_invoice_paid']);
    expect(events.every((e) => e.status === 'pending')).toBe(true);
  });

  it('does not create duplicate outbox events when the same bank webhook is delivered twice', async () => {
    const { merchant, customer, virtualAccount } = await makeFixtures();
    const bankReference = `bankref_${new mongoose.Types.ObjectId()}`;

    const first = await recordIncomingPayment({
      reference: virtualAccount.reference,
      merchantId: merchant._id,
      customerId: customer._id,
      virtualAccountId: virtualAccount._id,
      amountReceived: 100_000,
      amountExpected: 100_000,
      currency: 'NGN',
      bankReference,
    });
    expect(first.duplicate).toBe(false);

    // Simulate the bank (or a retried webhook delivery) sending the exact
    // same event again.
    const second = await recordIncomingPayment({
      reference: virtualAccount.reference,
      merchantId: merchant._id,
      customerId: customer._id,
      virtualAccountId: virtualAccount._id,
      amountReceived: 100_000,
      amountExpected: 100_000,
      currency: 'NGN',
      bankReference,
    });
    expect(second.duplicate).toBe(true);
    expect(second.transaction._id.toString()).toBe(first.transaction._id.toString());

    // Exactly 3 outbox events total (one per type), not 6 - the second
    // call short-circuits before ever reaching the enqueue step.
    const events = await OutboxEvent.find({ sourceType: 'transaction', sourceRef: first.transaction._id.toString() });
    expect(events).toHaveLength(3);
  });

  it('tick() claims and completes due events, even if no worker ever ran until now', async () => {
    const { merchant, customer, virtualAccount } = await makeFixtures();

    const { transaction } = await recordIncomingPayment({
      reference: virtualAccount.reference,
      merchantId: merchant._id,
      customerId: customer._id,
      virtualAccountId: virtualAccount._id,
      amountReceived: 100_000,
      amountExpected: 100_000,
      currency: 'NGN',
      bankReference: `bankref_${new mongoose.Types.ObjectId()}`,
    });

    // "DB commit succeeds, worker never runs (yet)" - the events just
    // sit there, pending, however long it takes for a worker to show up.
    const pending = await OutboxEvent.find({ sourceType: 'transaction', sourceRef: transaction._id.toString(), status: 'pending' });
    expect(pending).toHaveLength(3);

    // Now the worker finally starts and ticks once.
    const processed = await tick();
    expect(processed).toBe(3);

    const afterTick = await OutboxEvent.find({ sourceType: 'transaction', sourceRef: transaction._id.toString() });
    // deactivate_virtual_account and mark_invoice_paid should complete
    // cleanly (no merchant webhook URL configured, no subscription
    // invoice exists - both handlers no-op safely). dispatch_merchant_webhook
    // also completes: it only needs to durably persist a
    // MerchantWebhookDelivery row, not actually deliver over HTTP.
    expect(afterTick.every((e) => e.status === 'completed')).toBe(true);
  });

  it('recovers events left stuck in processing by a worker that crashed mid-attempt', async () => {
    const { merchant, customer, virtualAccount } = await makeFixtures();

    const { transaction } = await recordIncomingPayment({
      reference: virtualAccount.reference,
      merchantId: merchant._id,
      customerId: customer._id,
      virtualAccountId: virtualAccount._id,
      amountReceived: 100_000,
      amountExpected: 100_000,
      currency: 'NGN',
      bankReference: `bankref_${new mongoose.Types.ObjectId()}`,
    });

    // Simulate a worker that claimed a batch and then died before
    // finishing (no markCompleted/markFailed ever called).
    const claimed = await claimBatch(10);
    expect(claimed.length).toBe(3);

    // Manually backdate claimedAt to simulate time passing since the
    // "crash", since claimBatch() just claimed them a moment ago.
    await OutboxEvent.updateMany(
      { _id: { $in: claimed.map((e) => e._id) } },
      { $set: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) } }
    );

    const stillProcessing = await OutboxEvent.find({ sourceType: 'transaction', sourceRef: transaction._id.toString() });
    expect(stillProcessing.every((e) => e.status === 'processing')).toBe(true);

    const recoveredCount = await redriveStuckProcessing(5 * 60 * 1000);
    expect(recoveredCount).toBe(3);

    const recovered = await OutboxEvent.find({ sourceType: 'transaction', sourceRef: transaction._id.toString() });
    expect(recovered.every((e) => e.status === 'pending')).toBe(true);

    // And now a fresh tick() picks them up and finishes the job the
    // dead worker never got to.
    const processed = await tick();
    expect(processed).toBe(3);
  });

  it('retries a transiently-failing event with backoff, then succeeds', async () => {
    const { merchant, customer, virtualAccount } = await makeFixtures();

    const { transaction } = await recordIncomingPayment({
      reference: virtualAccount.reference,
      merchantId: merchant._id,
      customerId: customer._id,
      virtualAccountId: virtualAccount._id,
      amountReceived: 100_000,
      amountExpected: 100_000,
      currency: 'NGN',
      bankReference: `bankref_${new mongoose.Types.ObjectId()}`,
    });

    const [event] = await OutboxEvent.find({
      sourceType: 'transaction',
      sourceRef: transaction._id.toString(),
      eventType: 'mark_invoice_paid',
    });

    // Simulate one failed attempt (e.g. a transient DB blip).
    const claimed = await OutboxEvent.findByIdAndUpdate(
      event._id,
      { $set: { status: 'processing', claimedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true }
    );
    const { permanentlyFailed } = await markFailed(claimed, new Error('simulated_transient_failure'));
    expect(permanentlyFailed).toBe(false);

    const afterFailure = await OutboxEvent.findById(event._id);
    expect(afterFailure.status).toBe('pending');
    expect(afterFailure.availableAt.getTime()).toBeGreaterThan(Date.now()); // backed off into the future

    // Make it due immediately (rather than sleeping in the test) and
    // let a fresh tick pick it up and succeed this time.
    await OutboxEvent.findByIdAndUpdate(event._id, { availableAt: new Date() });
    await tick();

    const afterRetry = await OutboxEvent.findById(event._id);
    expect(afterRetry.status).toBe('completed');
    expect(afterRetry.attempts).toBe(2); // one failed attempt + one successful
  });

  it('permanently fails an event after maxAttempts, without retrying forever', async () => {
    const { merchant, customer, virtualAccount } = await makeFixtures();

    const { transaction } = await recordIncomingPayment({
      reference: virtualAccount.reference,
      merchantId: merchant._id,
      customerId: customer._id,
      virtualAccountId: virtualAccount._id,
      amountReceived: 100_000,
      amountExpected: 100_000,
      currency: 'NGN',
      bankReference: `bankref_${new mongoose.Types.ObjectId()}`,
    });

    const [event] = await OutboxEvent.find({
      sourceType: 'transaction',
      sourceRef: transaction._id.toString(),
      eventType: 'mark_invoice_paid',
    });

    await OutboxEvent.findByIdAndUpdate(event._id, { maxAttempts: 2 });

    // Exhaust both attempts with simulated failures.
    for (let i = 0; i < 2; i += 1) {
      const claimed = await OutboxEvent.findByIdAndUpdate(
        event._id,
        { $set: { status: 'processing', claimedAt: new Date() }, $inc: { attempts: 1 } },
        { new: true }
      );
      // eslint-disable-next-line no-await-in-loop
      await markFailed(claimed, new Error('permanently_broken'));
    }

    const final = await OutboxEvent.findById(event._id);
    expect(final.status).toBe('failed');
    expect(final.lastError).toBe('permanently_broken');

    // A failed event is NOT claimable anymore - claimBatch only matches
    // 'pending', so it stops consuming worker capacity retrying
    // something that needs a human, not more automatic retries.
    const claimable = await claimBatch(10);
    expect(claimable.find((e) => e._id.toString() === event._id.toString())).toBeUndefined();
  });
});
