// tests/requestFingerprint.test.js
const { computeRequestFingerprint, assertFingerprintMatches } = require('../src/utils/requestFingerprint');

describe('computeRequestFingerprint', () => {
  it('is stable for the same fields regardless of key order', () => {
    const a = computeRequestFingerprint({ amount: 1000, currency: 'NGN', destination: 'X' });
    const b = computeRequestFingerprint({ destination: 'X', currency: 'NGN', amount: 1000 });
    expect(a).toBe(b);
  });

  it('changes when any field value changes', () => {
    const a = computeRequestFingerprint({ amount: 1000, currency: 'NGN' });
    const b = computeRequestFingerprint({ amount: 2000, currency: 'NGN' });
    expect(a).not.toBe(b);
  });

  it('treats null and undefined the same way', () => {
    const a = computeRequestFingerprint({ amount: 1000, note: null });
    const b = computeRequestFingerprint({ amount: 1000, note: undefined });
    expect(a).toBe(b);
  });

  it('distinguishes numeric and string forms consistently (both stringified)', () => {
    const a = computeRequestFingerprint({ amount: 1000 });
    const b = computeRequestFingerprint({ amount: '1000' });
    expect(a).toBe(b); // both normalized to the string "1000" - see computeRequestFingerprint
  });
});

describe('assertFingerprintMatches', () => {
  it('does not throw when fingerprints match', () => {
    const fields = { amount: 5000, currency: 'NGN', destinationAccountNumber: '0123456789' };
    const existing = computeRequestFingerprint(fields);
    expect(() => assertFingerprintMatches(existing, fields)).not.toThrow();
  });

  it('throws IDEMPOTENCY_KEY_CONFLICT when the request differs', () => {
    const original = computeRequestFingerprint({ amount: 5000, currency: 'NGN' });
    let caught;
    try {
      assertFingerprintMatches(original, { amount: 999999, currency: 'NGN' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toBe('idempotency_key_reused_with_different_request');
    expect(caught.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('does not throw when there is no existing fingerprint to compare against (first use of the key)', () => {
    expect(() => assertFingerprintMatches(null, { amount: 5000 })).not.toThrow();
  });
});
