// tests/limits.test.js
const limits = require('../src/config/limits');

describe('MIN_SINGLE_PAYMENT_MINOR', () => {
  it('defaults to the global minimum when merchant is null', () => {
    const resolved = limits.getLimitsForMerchant(null);
    expect(resolved.MIN_SINGLE_PAYMENT_MINOR).toBe(limits.MIN_SINGLE_PAYMENT_MINOR);
  });

  it('is not affected by merchant plan (same floor for every tier)', () => {
    const starter = limits.getLimitsForMerchant({ plan: 'starter' });
    const enterprise = limits.getLimitsForMerchant({ plan: 'enterprise' });
    expect(starter.MIN_SINGLE_PAYMENT_MINOR).toBe(enterprise.MIN_SINGLE_PAYMENT_MINOR);
  });

  it('respects an overridden env value', () => {
    const ORIGINAL = process.env.MIN_SINGLE_PAYMENT_MINOR;
    process.env.MIN_SINGLE_PAYMENT_MINOR = '2500';
    jest.resetModules();
    const reloaded = require('../src/config/limits');
    expect(reloaded.getLimitsForMerchant(null).MIN_SINGLE_PAYMENT_MINOR).toBe(2500);
    process.env.MIN_SINGLE_PAYMENT_MINOR = ORIGINAL;
    jest.resetModules();
  });
});
