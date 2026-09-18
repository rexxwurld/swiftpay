// tests/integration/adminOpsTooling.test.js
//
// Covers the admin read-only browsing + manual redrive added during the
// Sep 2026 transfer-only audit for req. #24 ("dashboard/API for ...
// webhook events, failed jobs, dead-letter events ... audit logs ...
// merchants") and req. #5 ("provide manual redrive"). Before this, every
// admin.routes.js endpoint was an *action* (resolve, verify, fees) with
// no way to browse the underlying data, and a dead-lettered webhook event
// could only be retried by editing the database directly.
//
// webhookQueue.js needs a real Redis connection (BullMQ), which this
// sandbox doesn't have - mocked the same way other tests here mock a
// dependency that needs infra this environment can't provide (see
// withdrawalAmbiguousOutcome.test.js mocking wallet.service).

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

const mockGetJob = jest.fn();
const mockEnqueueWebhookEvent = jest.fn();

jest.mock('../../src/queue/webhookQueue', () => ({
  webhookQueue: { getJob: (...args) => mockGetJob(...args) },
  enqueueWebhookEvent: (...args) => mockEnqueueWebhookEvent(...args),
}));

let Merchant, WebhookEvent;
let listAuditLogs, auditLogRecord;
let redriveFailedEvent;

beforeAll(async () => {
  await startTestDb();

  Merchant = require('../../src/modules/merchant/merchant.model');
  WebhookEvent = require('../../src/modules/webhook/webhookEvent.model');

  ({ list: listAuditLogs, record: auditLogRecord } = require('../../src/modules/audit/auditLog.service'));
  ({ redriveFailedEvent } = require('../../src/modules/webhook/webhook.processor'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
  mockGetJob.mockReset();
  mockEnqueueWebhookEvent.mockReset();
});

describe('audit log listing (admin browsing)', () => {
  it('filters by severity and returns newest first', async () => {
    await auditLogRecord({ actorType: 'system', actorRef: 'x', action: 'a.one', severity: 'info' });
    await auditLogRecord({ actorType: 'system', actorRef: 'x', action: 'a.two', severity: 'critical' });
    await auditLogRecord({ actorType: 'system', actorRef: 'x', action: 'a.three', severity: 'critical' });

    const criticalOnly = await listAuditLogs({ severity: 'critical' });
    expect(criticalOnly).toHaveLength(2);
    expect(criticalOnly.every((l) => l.severity === 'critical')).toBe(true);
    // newest first
    expect(criticalOnly[0].action).toBe('a.three');
  });

  it('caps the limit at 200 regardless of what is requested', async () => {
    const result = await listAuditLogs({ limit: 999999 });
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe('merchant listing excludes secrets', () => {
  it('never returns secret key hashes or password hash', async () => {
    const suffix = new mongoose.Types.ObjectId().toString();
    await Merchant.create({
      businessName: 'Test Merchant',
      email: `merchant_${suffix}@example.com`,
      passwordHash: 'not_a_real_hash',
      testPublicKey: `pk_test_${suffix}`,
      testSecretKeyHash: `hash_test_${suffix}`,
      livePublicKey: `pk_live_${suffix}`,
      liveSecretKeyHash: `hash_live_${suffix}`,
    });

    // Mirrors the admin.routes.js GET /merchants projection exactly.
    const merchants = await Merchant.find({})
      .select('-passwordHash -testSecretKeyHash -liveSecretKeyHash -webhookSecret');

    expect(merchants).toHaveLength(1);
    expect(merchants[0].passwordHash).toBeUndefined();
    expect(merchants[0].testSecretKeyHash).toBeUndefined();
    expect(merchants[0].liveSecretKeyHash).toBeUndefined();
    expect(merchants[0].testPublicKey).toBe(`pk_test_${suffix}`); // public key IS fine to show
  });
});

describe('webhook event manual redrive', () => {
  it('rejects redriving an event that is not in the failed state', async () => {
    const event = await WebhookEvent.create({
      providerEventId: 'evt-1',
      rawBody: { accountNumber: 'x' },
      status: 'processed',
    });

    await expect(redriveFailedEvent(event._id)).rejects.toThrow('webhook_event_not_in_failed_state');
    expect(mockEnqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it('resets a dead-lettered event and re-enqueues it, removing any stale terminal job first', async () => {
    const event = await WebhookEvent.create({
      providerEventId: 'evt-2',
      rawBody: { accountNumber: 'x' },
      status: 'failed',
      attempts: 5,
      lastError: 'some_permanent_looking_error',
    });

    const mockRemove = jest.fn().mockResolvedValue(undefined);
    mockGetJob.mockResolvedValue({ remove: mockRemove });

    const result = await redriveFailedEvent(event._id);

    expect(mockRemove).toHaveBeenCalled(); // stale terminal job cleared first
    expect(mockEnqueueWebhookEvent).toHaveBeenCalledWith(event._id);
    expect(result.status).toBe('queued');
    expect(result.attempts).toBe(0);
    expect(result.lastError).toBeNull();

    const reloaded = await WebhookEvent.findById(event._id);
    expect(reloaded.status).toBe('queued');
  });

  it('still redrives correctly when no stale job exists in the queue', async () => {
    const event = await WebhookEvent.create({
      providerEventId: 'evt-3',
      rawBody: { accountNumber: 'x' },
      status: 'failed',
      attempts: 5,
    });

    mockGetJob.mockResolvedValue(null);

    const result = await redriveFailedEvent(event._id);
    expect(result.status).toBe('queued');
    expect(mockEnqueueWebhookEvent).toHaveBeenCalledWith(event._id);
  });
});
