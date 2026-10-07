// Shared API helper. The dashboard authenticates via the httpOnly session
// cookie set by POST /api/auth/login - fetch() sends it automatically for
// same-origin requests, so no token handling needed in the browser.
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) },
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 401) {
    // /api/auth/* returns 401 for bad credentials / bad 2FA codes. That is a
    // normal form error, not an expired session - never redirect for it,
    // otherwise a wrong password reloads the login page with "unauthenticated".
    const isAuthEndpoint = /\/api(\/v1)?\/auth\//.test(path);
    if (!isAuthEndpoint) {
      window.location.href = '/onboarding?tab=login';
      throw new Error('unauthenticated');
    }
  }

  if (!res.ok || body.status === false) {
    throw new Error(body.message || `request_failed_${res.status}`);
  }
  return body;
}

function money(minor) {
  if (minor === null || minor === undefined) return '—';
  return '₦' + (minor / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
}
