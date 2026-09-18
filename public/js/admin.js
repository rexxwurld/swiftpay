// Admin dashboard for the account pool AND for resolving stuck
// payments. Two separate credentials, matching the API's two auth
// layers (see src/modules/admin/adminUser.model.js):
//   1. INFRA_ADMIN_KEY - unlocks the dashboard itself, sent as
//      x-admin-key on every request. Lives in sessionStorage.
//   2. Named admin session (email/password -> Bearer token from
//      POST /admin/auth/login) - additionally required for the
//      money-moving actions (resolving stuck payouts/withdrawals/
//      refunds). Lives in sessionStorage separately, and is optional -
//      the dashboard is fully usable without it, just read-only on the
//      stuck-payments table until signed in.
// Both cleared when the tab closes (sessionStorage, not localStorage).

const KEY_STORAGE = 'swiftpay_admin_key';
const SESSION_STORAGE = 'swiftpay_admin_session';

function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function getKey() {
  return sessionStorage.getItem(KEY_STORAGE);
}

function setKey(key) {
  sessionStorage.setItem(KEY_STORAGE, key);
}

function clearKey() {
  sessionStorage.removeItem(KEY_STORAGE);
}

function getSession() {
  const raw = sessionStorage.getItem(SESSION_STORAGE);
  return raw ? JSON.parse(raw) : null;
}

function setSession(token, admin) {
  sessionStorage.setItem(SESSION_STORAGE, JSON.stringify({ token, admin }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_STORAGE);
}

async function adminApi(path, options = {}) {
  const key = getKey();
  const session = getSession();
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': key || '',
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 401 && body.message !== 'admin_session_required' && body.message !== 'invalid_or_expired_admin_session') {
    clearKey();
    showLogin('Invalid or expired admin key.');
    throw new Error('unauthorized');
  }
  if (res.status === 401 || res.status === 403) {
    // The x-admin-key is still fine - just missing/expired/insufficient
    // named admin session. Don't kick back to the outer login screen for
    // this; the caller decides how to prompt for a session.
    const err = new Error(body.message || 'admin_session_required');
    err.needsSession = true;
    throw err;
  }
  if (!res.ok || body.status === false) {
    throw new Error(body.message || `request_failed_${res.status}`);
  }
  return body;
}

function showLogin(errMsg) {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashScreen').style.display = 'none';
  document.getElementById('logoutBtn').style.display = 'none';
  const errEl = document.getElementById('loginErr');
  if (errMsg) {
    errEl.textContent = errMsg;
    errEl.classList.add('show');
  } else {
    errEl.classList.remove('show');
  }
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashScreen').style.display = 'block';
  document.getElementById('logoutBtn').style.display = 'inline-block';
  loadPoolStatus();
  refreshSessionUi();
  loadStuckPayments();
  loadWebhookEvents();
  loadAuditLogs();
  loadMerchants();
}

/* ---------- Named admin session ---------- */

function refreshSessionUi() {
  const session = getSession();
  const statusEl = document.getElementById('sessionStatus');
  const formEl = document.getElementById('sessionForm');
  const logoutBtn = document.getElementById('sessionLogoutBtn');

  if (session) {
    statusEl.textContent = `Signed in as ${session.admin.email} (${session.admin.role})`;
    statusEl.classList.add('on');
    formEl.style.display = 'none';
    logoutBtn.style.display = 'inline-block';
  } else {
    statusEl.textContent = 'Not signed in — required to resolve stuck payments below.';
    statusEl.classList.remove('on');
    formEl.style.display = 'flex';
    logoutBtn.style.display = 'none';
  }
}

async function sessionLogin() {
  const email = document.getElementById('sessionEmail').value.trim();
  const password = document.getElementById('sessionPassword').value;
  if (!email || !password) return;

  const btn = document.getElementById('sessionLoginBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': getKey() || '' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === false) {
      throw new Error(body.message || 'login_failed');
    }
    setSession(body.data.token, body.data.admin);
    document.getElementById('sessionPassword').value = '';
    refreshSessionUi();
    toast('Signed in.');
    loadStuckPayments();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Stuck payments ---------- */

function fmtAmount(minor, currency) {
  if (minor == null) return '—';
  return `${(minor / 100).toLocaleString()} ${currency || ''}`.trim();
}

function fmtAge(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

async function loadStuckPayments() {
  try {
    const res = await adminApi('/stuck-payments');
    renderStuckTable(res.data || {});
  } catch (err) {
    if (err.message !== 'unauthorized' && !err.needsSession) toast(err.message, true);
  }
}

function renderStuckTable(data) {
  const rows = [
    ...(data.payouts || []).map((p) => ({ ...p, kind: 'Payout', resolveType: 'payouts' })),
    ...(data.withdrawals || []).map((w) => ({ ...w, kind: 'Withdrawal', resolveType: 'withdrawals' })),
    ...(data.refunds || []).map((r) => ({ ...r, kind: 'Refund', resolveType: 'refunds' })),
  ];

  const body = document.getElementById('stuckTableBody');
  const empty = document.getElementById('stuckEmpty');

  if (!rows.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  body.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.kind}</td>
      <td class="mono">${r.reference}</td>
      <td class="mono">${fmtAmount(r.amount, r.currency)}</td>
      <td><span class="pill low">${r.status}</span></td>
      <td>${fmtAge(r.createdAt)}</td>
      <td>
        <div class="resolve-actions">
          <button class="btn ok" data-resolve="${r.resolveType}" data-reference="${r.reference}" data-success="true">Mark succeeded</button>
          <button class="btn fail" data-resolve="${r.resolveType}" data-reference="${r.reference}" data-success="false">Mark failed</button>
        </div>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-resolve]').forEach((btn) => {
    btn.addEventListener('click', () => resolveStuckPayment(btn));
  });
}

async function resolveStuckPayment(btn) {
  const { resolve: kind, reference, success } = btn.dataset;

  if (!getSession()) {
    toast('Sign in with a named admin session first - see above.', true);
    return;
  }

  const confirmed = window.confirm(
    `Mark this ${kind.slice(0, -1)} (${reference}) as ${success === 'true' ? 'SUCCEEDED' : 'FAILED'}?\n\n` +
    'Only do this after checking the real outcome with the bank directly - this call trusts you completely and does not verify anything on its own.'
  );
  if (!confirmed) return;

  btn.disabled = true;
  try {
    await adminApi(`/${kind}/${encodeURIComponent(reference)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ success: success === 'true' }),
    });
    toast('Resolved.');
    loadStuckPayments();
  } catch (err) {
    if (err.needsSession) {
      toast('Your admin session expired - sign in again above.', true);
      clearSession();
      refreshSessionUi();
    } else {
      toast(err.message, true);
    }
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Pool status ---------- */

let lastPool = [];

async function loadPoolStatus() {
  try {
    const res = await adminApi('/pool-status');
    lastPool = res.data || [];
    renderPoolTable(lastPool);
    renderBankSelect(lastPool);
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, true);
  }
}

function renderPoolTable(rows) {
  const body = document.getElementById('poolTableBody');
  const empty = document.getElementById('poolEmpty');

  if (!rows.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const LOW_THRESHOLD = 20; // mirrors POOL_MIN_THRESHOLD default - display only

  // Only the LIVE pool is a real operational resource - test accounts
  // are generated on demand for free (see provisionAccountPool), so
  // there's nothing to show for test here.
  body.innerHTML = rows.map((r) => {
    const low = r.live.available <= LOW_THRESHOLD;
    return `
      <tr>
        <td class="mono">${r.bank}</td>
        <td class="mono">${r.live.available}</td>
        <td class="mono">${r.live.assigned}</td>
        <td><span class="pill ${low ? 'low' : 'ok'}">${low ? 'Low' : 'Healthy'}</span></td>
      </tr>
    `;
  }).join('');
}

function renderBankSelect(rows) {
  const select = document.getElementById('bankSelect');
  const current = select.value;
  select.innerHTML = rows.map((r) => `<option value="${r.bank}">${r.bank}</option>`).join('');
  if (current && rows.some((r) => r.bank === current)) select.value = current;
}

/* ---------- Provision ---------- */

async function provisionPool() {
  const bankSlug = document.getElementById('bankSelect').value;
  const count = parseInt(document.getElementById('countInput').value, 10) || 20;

  if (!bankSlug) {
    toast('No bank selected.', true);
    return;
  }

  const btn = document.getElementById('provisionBtn');
  btn.disabled = true;
  try {
    // Always live - test-mode accounts are minted on demand per
    // checkout and are never pre-provisioned (see bankPartner.service.js).
    const res = await adminApi(
      `/provision-pool?bankSlug=${encodeURIComponent(bankSlug)}&count=${count}&mode=live`,
      { method: 'GET' }
    );
    toast(res.message || 'Provisioned.');
    await loadPoolStatus();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Wiring ---------- */

document.getElementById('unlockBtn').addEventListener('click', async () => {
  const input = document.getElementById('adminKeyInput');
  const key = input.value.trim();
  if (!key) return;

  setKey(key);
  try {
    await adminApi('/pool-status'); // validates the key
    showDashboard();
  } catch (err) {
    // showLogin() with the error was already called by adminApi on 401
    if (err.message !== 'unauthorized') toast(err.message, true);
  }
});

document.getElementById('adminKeyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('unlockBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearKey();
  clearSession();
  showLogin();
});

document.getElementById('sessionLoginBtn').addEventListener('click', sessionLogin);
document.getElementById('sessionPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('sessionLoginBtn').click();
});
document.getElementById('sessionLogoutBtn').addEventListener('click', () => {
  clearSession();
  refreshSessionUi();
  toast('Signed out of admin session.');
});

document.getElementById('stuckRefreshBtn').addEventListener('click', loadStuckPayments);

/* ---------- Webhook events ---------- */

async function loadWebhookEvents() {
  try {
    const status = document.getElementById('whStatusFilter').value;
    const res = await adminApi(`/webhook-events${status ? `?status=${status}` : ''}`);
    renderWebhookEvents(res.data || []);
  } catch (err) {
    if (err.message !== 'unauthorized' && !err.needsSession) toast(err.message, true);
  }
}

function renderWebhookEvents(events) {
  const body = document.getElementById('whTableBody');
  const empty = document.getElementById('whEmpty');

  if (!events.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  body.innerHTML = events.map((e) => `
    <tr>
      <td class="mono">${e.providerEventId || '—'}</td>
      <td>${e.source || '—'}</td>
      <td><span class="pill ${e.status === 'failed' ? 'low' : e.status === 'processed' ? 'ok' : ''}">${e.status}</span></td>
      <td>${e.attempts ?? 0}</td>
      <td class="mono" style="max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${e.lastError || ''}">${e.lastError || '—'}</td>
      <td>${fmtAge(e.updatedAt)} ago</td>
      <td>${e.status === 'failed' ? `<button class="btn ok" data-redrive="${e._id}">Redrive</button>` : ''}</td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-redrive]').forEach((btn) => {
    btn.addEventListener('click', () => redriveWebhookEvent(btn));
  });
}

async function redriveWebhookEvent(btn) {
  if (!getSession()) {
    toast('Sign in with a named admin session first - see above.', true);
    return;
  }

  const id = btn.dataset.redrive;
  const confirmed = window.confirm(
    'Redrive this dead-lettered webhook event? It will be reprocessed from scratch - ' +
    'only do this once you know why it originally failed (e.g. a downstream bug has since been fixed).'
  );
  if (!confirmed) return;

  btn.disabled = true;
  try {
    await adminApi(`/webhook-events/${id}/redrive`, { method: 'POST' });
    toast('Event requeued.');
    await loadWebhookEvents();
  } catch (err) {
    if (err.needsSession) {
      toast('Your admin session expired - sign in again above.', true);
      clearSession();
      refreshSessionUi();
    } else {
      toast(err.message, true);
    }
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('whRefreshBtn').addEventListener('click', loadWebhookEvents);
document.getElementById('whStatusFilter').addEventListener('change', loadWebhookEvents);

/* ---------- Audit logs ---------- */

async function loadAuditLogs() {
  try {
    const severity = document.getElementById('alSeverityFilter').value;
    const res = await adminApi(`/audit-logs${severity ? `?severity=${severity}` : ''}`);
    renderAuditLogs(res.data || []);
  } catch (err) {
    if (err.message !== 'unauthorized' && !err.needsSession) toast(err.message, true);
  }
}

function renderAuditLogs(logs) {
  const body = document.getElementById('alTableBody');
  const empty = document.getElementById('alEmpty');

  if (!logs.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  body.innerHTML = logs.map((l) => `
    <tr>
      <td class="mono">${l.action}</td>
      <td>${l.actorType}${l.actorRef ? ` (${l.actorRef})` : ''}</td>
      <td>${l.entityType ? `${l.entityType}${l.entityRef ? ` / ${l.entityRef}` : ''}` : '—'}</td>
      <td><span class="pill ${l.severity === 'critical' ? 'low' : l.severity === 'warning' ? '' : 'ok'}">${l.severity}</span></td>
      <td>${fmtAge(l.createdAt)} ago</td>
    </tr>
  `).join('');
}

document.getElementById('alRefreshBtn').addEventListener('click', loadAuditLogs);
document.getElementById('alSeverityFilter').addEventListener('change', loadAuditLogs);

/* ---------- Merchants ---------- */

async function loadMerchants() {
  try {
    const res = await adminApi('/merchants');
    renderMerchants(res.data || []);
  } catch (err) {
    if (err.message !== 'unauthorized' && !err.needsSession) toast(err.message, true);
  }
}

function renderMerchants(merchants) {
  const body = document.getElementById('merchTableBody');
  const empty = document.getElementById('merchEmpty');

  if (!merchants.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  body.innerHTML = merchants.map((m) => `
    <tr>
      <td>${m.businessName}</td>
      <td>${m.email}</td>
      <td>${m.plan || 'starter'}</td>
      <td><span class="pill ${m.isVerified ? 'ok' : 'low'}">${m.isVerified ? 'Verified' : 'Unverified'}</span></td>
      <td>${fmtAge(m.createdAt)} ago</td>
    </tr>
  `).join('');
}

document.getElementById('merchRefreshBtn').addEventListener('click', loadMerchants);

document.getElementById('refreshBtn').addEventListener('click', loadPoolStatus);
document.getElementById('provisionBtn').addEventListener('click', provisionPool);

/* ---------- Init ---------- */

if (getKey()) {
  showDashboard();
} else {
  showLogin();
}
