// tests/adminKey.middleware.test.js
describe('requireAdminKey', () => {
  const ORIGINAL_ENV = process.env.INFRA_ADMIN_KEY;

  afterEach(() => {
    process.env.INFRA_ADMIN_KEY = ORIGINAL_ENV;
    jest.resetModules();
  });

  function makeReqRes(headerKey) {
    const req = { headers: headerKey ? { 'x-admin-key': headerKey } : {}, query: {} };
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    return { req, res };
  }

  it('fails closed with 500 when INFRA_ADMIN_KEY is not configured', () => {
    delete process.env.INFRA_ADMIN_KEY;
    jest.resetModules();
    const requireAdminKey = require('../src/middleware/adminKey.middleware');
    const { req, res } = makeReqRes('anything');
    requireAdminKey(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe('admin_key_not_configured');
  });

  it('rejects a missing key with 401', () => {
    process.env.INFRA_ADMIN_KEY = 'correct-key';
    jest.resetModules();
    const requireAdminKey = require('../src/middleware/adminKey.middleware');
    const { req, res } = makeReqRes(undefined);
    requireAdminKey(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong key with 401', () => {
    process.env.INFRA_ADMIN_KEY = 'correct-key';
    jest.resetModules();
    const requireAdminKey = require('../src/middleware/adminKey.middleware');
    const { req, res } = makeReqRes('wrong-key');
    requireAdminKey(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a key that is a prefix of the correct one (length-dependent bug guard)', () => {
    process.env.INFRA_ADMIN_KEY = 'correct-key';
    jest.resetModules();
    const requireAdminKey = require('../src/middleware/adminKey.middleware');
    const { req, res } = makeReqRes('correct');
    requireAdminKey(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  it('calls next() for the correct key', () => {
    process.env.INFRA_ADMIN_KEY = 'correct-key';
    jest.resetModules();
    const requireAdminKey = require('../src/middleware/adminKey.middleware');
    const { req, res } = makeReqRes('correct-key');
    const next = jest.fn();
    requireAdminKey(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });
});
