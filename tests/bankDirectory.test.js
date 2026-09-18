// tests/bankDirectory.test.js
const { listBanks, findBankByCode, isKnownBankCode } = require('../src/config/banks');

describe('config/banks', () => {
  it('lists only active banks by default', () => {
    const banks = listBanks();
    expect(banks.length).toBeGreaterThan(0);
    expect(banks.every((b) => b.active)).toBe(true);
  });

  it('finds a known bank by its NIBSS code', () => {
    const bank = findBankByCode('058');
    expect(bank).not.toBeNull();
    expect(bank.name).toMatch(/GTBank/i);
  });

  it('returns null for an unknown code', () => {
    expect(findBankByCode('999999')).toBeNull();
  });

  it('isKnownBankCode is true only for active, seeded codes', () => {
    expect(isKnownBankCode('057')).toBe(true); // Zenith
    expect(isKnownBankCode('not-a-code')).toBe(false);
    expect(isKnownBankCode(undefined)).toBe(false);
  });

  it('every seeded bank has a unique code', () => {
    const banks = listBanks({ activeOnly: false });
    const codes = banks.map((b) => b.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
