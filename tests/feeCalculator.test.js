// tests/feeCalculator.test.js
const { computeFee } = require('../src/utils/feeCalculator');

describe('computeFee', () => {
  it('applies percentage + fixed fee once amount is at/above the waiver threshold', () => {
    // 300000 minor units (NGN 3,000) is above the NGN 2,500 waiver threshold
    const { feeAmount, netAmount } = computeFee(300000);
    expect(feeAmount).toBe(Math.floor((300000 * 150) / 10000) + 10000);
    expect(netAmount).toBe(300000 - feeAmount);
  });

  it('waives the fixed fee below the threshold, charging percentage only', () => {
    // 100000 minor units (NGN 1,000) is below the NGN 2,500 waiver threshold
    const { feeAmount, netAmount } = computeFee(100000);
    expect(feeAmount).toBe(Math.floor((100000 * 150) / 10000));
    expect(netAmount).toBe(100000 - feeAmount);
  });

  it('respects a per-merchant fee override', () => {
    const merchant = { fees: { percentageBps: 100, fixedMinor: 5000, capMinor: 0 } };
    const { feeAmount } = computeFee(1000000, merchant);
    expect(feeAmount).toBe(Math.floor((1000000 * 100) / 10000) + 5000);
  });

  it('caps the fee at capMinor even for large amounts', () => {
    const merchant = { fees: { percentageBps: 500, fixedMinor: 0, capMinor: 1000 } };
    const { feeAmount } = computeFee(10_000_000, merchant);
    expect(feeAmount).toBe(1000);
  });

  it('never lets the fee exceed the amount it is taken from', () => {
    const merchant = { fees: { percentageBps: 0, fixedMinor: 999999, capMinor: 0, waiveFixedBelowMinor: 0 } };
    const { feeAmount, netAmount } = computeFee(100, merchant);
    expect(feeAmount).toBe(100);
    expect(netAmount).toBe(0);
  });

  it('rejects non-integer or negative amounts', () => {
    expect(() => computeFee(-5)).toThrow('invalid_fee_base_amount');
    expect(() => computeFee(1.5)).toThrow('invalid_fee_base_amount');
  });
});
