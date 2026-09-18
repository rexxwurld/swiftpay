// tests/webhookSignature.test.js
process.env.BANK_WEBHOOK_SECRET = 'test_secret_for_jest';

const { signPayload, verifySignature } = require('../src/utils/webhookSignature');

describe('webhook signature verification', () => {
  const payload = { accountNumber: '1234567890', amountReceived: 50000 };

  it('verifies a correctly signed payload', () => {
    const signature = signPayload(payload);
    expect(verifySignature(payload, signature)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const signature = signPayload(payload);
    const tampered = { ...payload, amountReceived: 999999999 };
    expect(verifySignature(tampered, signature)).toBe(false);
  });

  it('rejects a forged/garbage signature', () => {
    expect(verifySignature(payload, 'not_a_real_signature')).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifySignature(payload, undefined)).toBe(false);
  });
});
