// src/config/currencies.js
//
// Central registry of currencies SwiftPay will hold balances in, post
// ledger entries in, and pay out in. Adding a currency here does NOT
// wire up an inbound rail for it - inbound collection is still NGN-only
// (dedicated virtual accounts are Nigerian bank accounts). What this
// enables is: merchants can hold a wallet per currency, request payouts
// and refunds in a currency that matches the transaction that funded it,
// and the platform stops silently mislabeling money.
//
// No FX conversion is implemented. SwiftPay never converts between
// currencies on a merchant's behalf - each currency is its own isolated
// ledger. A merchant with an NGN wallet and a USD wallet holds two
// balances, never one converted figure.

const SUPPORTED_CURRENCIES = {
  NGN: { name: 'Nigerian Naira', minorUnit: 'kobo', exponent: 2 },
  USD: { name: 'US Dollar', minorUnit: 'cent', exponent: 2 },
  GHS: { name: 'Ghanaian Cedi', minorUnit: 'pesewa', exponent: 2 },
  KES: { name: 'Kenyan Shilling', minorUnit: 'cent', exponent: 2 },
  ZAR: { name: 'South African Rand', minorUnit: 'cent', exponent: 2 },
};

function isSupportedCurrency(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, code.toUpperCase());
}

function normalizeCurrency(code) {
  if (!code) return 'NGN';
  const upper = String(code).toUpperCase();
  if (!isSupportedCurrency(upper)) {
    throw new Error(`unsupported_currency:${code}`);
  }
  return upper;
}

module.exports = { SUPPORTED_CURRENCIES, isSupportedCurrency, normalizeCurrency };
