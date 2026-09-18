// src/utils/sanctionsCheck.js
//
// STUB. Real AML/sanctions screening means checking counterparties against
// OFAC, UN, EU consolidated lists and Nigeria's own NFIU/EFCC watchlists,
// via a licensed screening provider (Refinitiv World-Check, ComplyAdvantage,
// Dow Jones Risk & Compliance, etc.) - fuzzy name matching, not exact string
// match. This function exists to show WHERE that check must run and to make
// it easy to swap in a real provider later; it is not a working control.

const DEV_DENYLIST = new Set(
  (process.env.SANCTIONS_DENYLIST_DEV || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * @returns {{ hit: boolean, reason?: string }}
 */
function screenName(fullName = '') {
  const normalized = fullName.trim().toLowerCase();
  if (!normalized) return { hit: false };
  if (DEV_DENYLIST.has(normalized)) {
    return { hit: true, reason: 'matched_dev_denylist' };
  }
  return { hit: false };
}

module.exports = { screenName };
