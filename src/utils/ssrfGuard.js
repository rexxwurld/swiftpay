// src/utils/ssrfGuard.js
//
// Merchant-controlled webhook URLs are an SSRF surface: SwiftPay's server
// (not the merchant's browser) makes the outbound HTTP call, so a
// malicious merchant could point webhookUrl at a private IP, a loopback
// address, or an internal-only hostname to reach infrastructure their own
// network can't (see audit report, High #15).
//
// This guard is applied in two places on purpose:
//   1. When the merchant SETS the webhook URL (fast feedback, rejects the
//      obviously bad case immediately).
//   2. Every time SwiftPay is about to SEND to it (deliverMerchantWebhook),
//      because DNS can change between those two points in time
//      (DNS-rebinding: a hostname that resolved to a public IP when saved
//      can be repointed at a private IP before delivery).
// Only re-checking at set-time is not sufficient by itself.

const dns = require('dns').promises;
const net = require('net');

function isDisallowedIp(ip) {
  const type = net.isIP(ip);

  if (type === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;

    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true; // "this network"
    if (a >= 224) return true; // multicast/reserved
    return false;
  }

  if (type === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true; // loopback
    if (normalized.startsWith('fe80:')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    if (normalized.startsWith('::ffff:')) {
      // IPv4-mapped IPv6 - re-check the embedded IPv4 address.
      const mapped = normalized.split(':').pop();
      if (net.isIP(mapped) === 4) return isDisallowedIp(mapped);
    }
    return false;
  }

  // Not a valid IP literal at all - treat as disallowed rather than guess.
  return true;
}

/**
 * Throws if `urlString` is not a safe destination for SwiftPay's server to
 * make an outbound request to right now. Resolves the hostname itself
 * (rather than trusting a cached/previous check) so DNS-rebinding can't
 * slip a private address in between validation and use.
 */
async function assertSafeWebhookUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('invalid_webhook_url');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('invalid_webhook_url');
  }

  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('webhook_url_must_be_https');
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new Error('webhook_url_not_allowed');
  }

  // A bare IP literal in the URL - validate it directly.
  if (net.isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new Error('webhook_url_not_allowed');
    }
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('webhook_url_could_not_be_resolved');
  }

  if (!records.length || records.some((r) => isDisallowedIp(r.address))) {
    throw new Error('webhook_url_not_allowed');
  }
}

module.exports = { assertSafeWebhookUrl, isDisallowedIp };
