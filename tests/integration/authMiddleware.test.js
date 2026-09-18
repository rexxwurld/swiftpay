// tests/integration/authMiddleware.test.js
//
// requireApiKey had no test coverage before this file. Covers basic
// secret-key auth plus the last-used tracking added during the Sep 2026
// transfer-only audit (req. #22 - API keys need last-used tracking,
// which this codebase otherwise already had hashing/rotation/mode
// separation for).

const mongoose = require('mongoose');
const { startTestDb, stopTestDb, clearTestDb } = require('./setup');

jest.setTimeout(30000);

let Merchant;
let requireApiKey;
let generateKeyPair, hashSecretKey;

beforeAll(async () => {
  await startTestDb();
  Merchant = require('../../src/modules/merchant/merchant.model');
  ({ requireApiKey } = require('../../src/middleware/auth.middleware'));
  ({ generateKeyPair, hashSecretKey } = require('../../src/utils/apiKeys'));
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

function makeReqRes(secretKey) {
  const req = { headers: secretKey ? { authorization: `Bearer ${secretKey}` } : {}, cookies: {} };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

async function makeMerchantWithKeys() {
  const suffix = new mongoose.Types.ObjectId().toString();
  const testKeys = generateKeyPair('test');
  const liveKeys = generateKeyPair('live');

  const merchant = await Merchant.create({
    businessName: 'Test Merchant',
    email: `merchant_${suffix}@example.com`,
    passwordHash: 'not_a_real_hash',
    testPublicKey: testKeys.publicKey,
    testSecretKeyHash: hashSecretKey(testKeys.secretKey),
    livePublicKey: liveKeys.publicKey,
    liveSecretKeyHash: hashSecretKey(liveKeys.secretKey),
    isVerified: true,
  });

  return { merchant, testSecretKey: testKeys.secretKey, liveSecretKey: liveKeys.secretKey };
}

describe('requireApiKey', () => {
  it('rejects a missing key', async () => {
    const { req, res } = makeReqRes(undefined);
    await requireApiKey(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('missing_api_key');
  });

  it('rejects an unrecognized secret key', async () => {
    const { req, res } = makeReqRes('sk_test_not_a_real_key');
    await requireApiKey(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('invalid_api_key');
  });

  it('accepts a valid test secret key and sets req.merchant with mode=test', async () => {
    const { merchant, testSecretKey } = await makeMerchantWithKeys();
    const { req, res } = makeReqRes(testSecretKey);

    let nextCalled = false;
    await requireApiKey(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(req.merchant.id.toString()).toBe(merchant._id.toString());
    expect(req.merchant.mode).toBe('test');
  });

  it('records testKeyLastUsedAt on successful auth without touching liveKeyLastUsedAt', async () => {
    const { merchant, testSecretKey } = await makeMerchantWithKeys();
    const before = await Merchant.findById(merchant._id);
    expect(before.testKeyLastUsedAt).toBeNull();

    const { req, res } = makeReqRes(testSecretKey);
    await requireApiKey(req, res, () => {});

    // touchKeyLastUsed() is fire-and-forget (not awaited by the
    // middleware), so give its update a tick to land before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    const after = await Merchant.findById(merchant._id);
    expect(after.testKeyLastUsedAt).not.toBeNull();
    expect(after.liveKeyLastUsedAt).toBeNull();
  });

  it('does not rewrite testKeyLastUsedAt on a second request within the throttle window', async () => {
    const { merchant, testSecretKey } = await makeMerchantWithKeys();

    const { req: req1, res: res1 } = makeReqRes(testSecretKey);
    await requireApiKey(req1, res1, () => {});
    await new Promise((resolve) => setImmediate(resolve));

    const firstStamp = (await Merchant.findById(merchant._id)).testKeyLastUsedAt;
    expect(firstStamp).not.toBeNull();

    const { req: req2, res: res2 } = makeReqRes(testSecretKey);
    await requireApiKey(req2, res2, () => {});
    await new Promise((resolve) => setImmediate(resolve));

    const secondStamp = (await Merchant.findById(merchant._id)).testKeyLastUsedAt;
    expect(secondStamp.getTime()).toBe(firstStamp.getTime()); // throttled - no DB write on the second call
  });
});
