// src/config/banks.js
//
// Reference directory of Nigerian bank codes (NIBSS institution codes),
// used by GET /api/v1/banks (requirement: "do not hardcode bank
// information throughout the codebase" - this is the one place it
// lives) and to validate a merchant-supplied `bankCode` on
// recipient/withdrawal-settlement-account creation before it's ever
// sent anywhere.
//
// This is static reference data, not a call to RexxPay Bank - the same
// way Paystack/Flutterwave ship a fixed NIBSS bank list that rarely
// changes, independent of which processor you're integrated with. It is
// NOT a substitute for account-NAME resolution (see
// bankPartner.service.js#resolveBankAccount) - a valid bank code here
// only means "this is a real institution", not "this account number at
// that institution belongs to the name given".
//
// Only a subset of commonly-used banks is seeded. Extend as needed;
// keep `code` as the NIBSS 3-digit code, since that's what's threaded
// through Recipient/Withdrawal/settlementAccount as `bankCode`.
const BANKS = [
  { code: '044', name: 'Access Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '063', name: 'Access Bank (Diamond)', active: true, country: 'NG', currency: 'NGN' },
  { code: '050', name: 'Ecobank Nigeria', active: true, country: 'NG', currency: 'NGN' },
  { code: '070', name: 'Fidelity Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '011', name: 'First Bank of Nigeria', active: true, country: 'NG', currency: 'NGN' },
  { code: '214', name: 'First City Monument Bank (FCMB)', active: true, country: 'NG', currency: 'NGN' },
  { code: '058', name: 'Guaranty Trust Bank (GTBank)', active: true, country: 'NG', currency: 'NGN' },
  { code: '030', name: 'Heritage Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '301', name: 'Jaiz Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '082', name: 'Keystone Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '526', name: 'Parallex Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '076', name: 'Polaris Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '101', name: 'Providus Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '221', name: 'Stanbic IBTC Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '068', name: 'Standard Chartered Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '232', name: 'Sterling Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '100', name: 'Suntrust Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '302', name: 'Titan Trust Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '032', name: 'Union Bank of Nigeria', active: true, country: 'NG', currency: 'NGN' },
  { code: '033', name: 'United Bank for Africa (UBA)', active: true, country: 'NG', currency: 'NGN' },
  { code: '215', name: 'Unity Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '035', name: 'Wema Bank', active: true, country: 'NG', currency: 'NGN' },
  { code: '057', name: 'Zenith Bank', active: true, country: 'NG', currency: 'NGN' },
  // Mock/local bank used by this platform's own sister service for
  // dedicated virtual accounts - see bankPartner.model.js. Included so
  // a payout back to a RexxPay-issued virtual account resolves too.
  { code: '999', name: 'RexxPay Bank', active: true, country: 'NG', currency: 'NGN' },
];

const BY_CODE = new Map(BANKS.map((b) => [b.code, b]));

function listBanks({ activeOnly = true } = {}) {
  return activeOnly ? BANKS.filter((b) => b.active) : BANKS.slice();
}

function findBankByCode(code) {
  return BY_CODE.get(String(code || '').trim()) || null;
}

function isKnownBankCode(code) {
  const bank = findBankByCode(code);
  return !!bank && bank.active;
}

module.exports = { BANKS, listBanks, findBankByCode, isKnownBankCode };
