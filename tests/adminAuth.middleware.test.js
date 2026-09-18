// tests/adminAuth.middleware.test.js
const jwt = require('jsonwebtoken');

describe('requireAdminRole', () => {
  const ORIGINAL_SECRET = process.env.ADMIN_JWT_SECRET;

  beforeEach(() => {
    process.env.ADMIN_JWT_SECRET = 'test-admin-secret';
    jest.resetModules();
  });

  afterEach(() => {
    process.env.ADMIN_JWT_SECRET = ORIGINAL_SECRET;
  });

  function makeReqRes(token) {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    return { req, res };
  }

  function signAdminToken(payload, opts = {}) {
    return jwt.sign({ purpose: 'admin_session', ...payload }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h', ...opts });
  }

  it('rejects a request with no token', () => {
    const { requireAdminRole } = require('../src/middleware/adminAuth.middleware');
    const { req, res } = makeReqRes(undefined);
    requireAdminRole('finance', 'superadmin')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('admin_session_required');
  });

  it('rejects an invalid/garbage token', () => {
    const { requireAdminRole } = require('../src/middleware/adminAuth.middleware');
    const { req, res } = makeReqRes('not-a-real-jwt');
    requireAdminRole('finance', 'superadmin')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('invalid_or_expired_admin_session');
  });

  it('rejects a token signed with the wrong secret', () => {
    const { requireAdminRole } = require('../src/middleware/adminAuth.middleware');
    const wrongToken = jwt.sign({ purpose: 'admin_session', id: 'x', role: 'superadmin' }, 'wrong-secret', { expiresIn: '1h' });
    const { req, res } = makeReqRes(wrongToken);
    requireAdminRole('finance', 'superadmin')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token missing the admin_session purpose claim (defense against merchant-token replay)', () => {
    const { requireAdminRole } = require('../src/middleware/adminAuth.middleware');
    const merchantLikeToken = jwt.sign({ id: 'x', role: 'superadmin' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
    const { req, res } = makeReqRes(merchantLikeToken);
    requireAdminRole('finance', 'superadmin')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid session whose role is not in the allowed list', () => {
    const { requireAdminRole } = require('../src/middleware/adminAuth.middleware');
    const token = signAdminToken({ id: 'admin1', role: 'support' });
    const { req, res } = makeReqRes(token);
    requireAdminRole('finance', 'superadmin')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('insufficient_admin_role');
  });

  it('calls next() and attaches req.adminUser for an allowed role', () => {
    const { requireAdminRole } = require('../src/middleware/adminAuth.middleware');
    const token = signAdminToken({ id: 'admin1', role: 'finance' });
    const { req, res } = makeReqRes(token);
    const next = jest.fn();
    requireAdminRole('finance', 'superadmin')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.adminUser).toEqual({ id: 'admin1', role: 'finance' });
  });

  it('rejects an expired session', () => {
    const { requireAdminRole } = require('../src/middleware/adminAuth.middleware');
    const expiredToken = signAdminToken({ id: 'admin1', role: 'superadmin' }, { expiresIn: '-1h' });
    const { req, res } = makeReqRes(expiredToken);
    requireAdminRole('finance', 'superadmin')(req, res, () => { throw new Error('next() should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('invalid_or_expired_admin_session');
  });
});
