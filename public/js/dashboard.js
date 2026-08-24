let transactions = [];
let payouts = [];
let customers = [];
let refunds = [];
let disputes = [];
let plans = [];
let subscriptions = [];
let invoices = [];
let txFilter = '';
let txSearch = '';

/* ---------- Overview v2 state ---------- */
let ovRange = 'today';        // 'today' | '7d' | '30d' | 'custom'
let ovCustomStart = null;
let ovCustomEnd = null;
let ovMetric = 'volume';      // 'volume' | 'count'
let ovSpanDays = 30;          // 7 | 30 | 90 | 365
let rtxSearch = '';
let rtxStatusFilter = '';
let customerById = {};
let walletPendingMinor = null;

// The dashboard is a session login (httpOnly cookie), which has no
// key-derived mode - see auth.middleware. Session calls must still tell
// the API which wallet/transaction set to read, so this stays fixed at
// 'live': a logged-in merchant looking at their dashboard wants their
// real numbers, not a hidden toggle they might forget is set to test.
// Test-mode data is still fully reachable via a sk_test_ API key.
const VIEW_MODE = 'live';

function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('Copied to clipboard'),
    () => toast('Could not copy — select and copy manually', true)
  );
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Sets textContent by id, silently no-oping if that id isn't on the
// current page — safer than a bare getElementById().textContent chain
// when a panel gets moved/renamed between tabs.
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ---------- Sidebar navigation ---------- */
function showTab(name) {
  document.querySelectorAll('.side-link').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  // Chart.js can't size a canvas that was hidden (display:none) at creation time,
  // so re-render whenever a chart-bearing tab becomes visible.
  // Analytics charts now live inside the Settings tab (see dashboard.html).
  if (name === 'overview' || name === 'settings') {
    requestAnimationFrame(() => {
      renderCharts();
      if (name === 'overview') renderOverviewAnalytics();
    });
  }
}
document.querySelectorAll('.side-link').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
document.querySelectorAll('[data-goto]').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.goto));
});

/* ---------- Profile ---------- */
async function loadProfile() {
  const res = await api('/api/merchant/me');
  document.getElementById('bizName').textContent = res.data.businessName;
  document.getElementById('bizEmail').textContent = res.data.email;
  document.getElementById('webhookUrlInput').value = res.data.webhookUrl || '';

  document.getElementById('setBizName').textContent = res.data.businessName;
  document.getElementById('setBizEmail').textContent = res.data.email;
  document.getElementById('setTestPubKey').textContent = res.data.testPublicKey || '—';
  document.getElementById('setLivePubKey').textContent = res.data.livePublicKey || '—';

  const firstName = (res.data.businessName || '').trim().split(/\s+/)[0] || 'there';
  setText('ovGreetName', firstName);
  setText('sideBizName', res.data.businessName);
  setText('sideMerchantId', res.data._id ? `Merchant ID: ${res.data._id}` : '');
  const initial = (res.data.businessName || '?').trim().charAt(0).toUpperCase();
  setText('sideAvatarInitial', initial || '?');

  setText('topBizName', res.data.businessName);
  setText('topAvatarInitial', initial || '?');
}

/* ---------- Wallet ---------- */
let walletBalanceMinor = null;
let balanceRevealed = false;

function renderBalanceCard() {
  const masked = '₦ ******';
  setText('balNGN', balanceRevealed ? money(walletBalanceMinor) : masked);
  setText('balDetailNGN', walletBalanceMinor === null ? '—' : money(walletBalanceMinor));
}

async function loadWallet() {
  const res = await api(`/api/wallet?mode=${VIEW_MODE}`);
  walletBalanceMinor = res.data.balance;
  walletPendingMinor = res.data.pendingSettlementBalance ?? 0;
  renderBalanceCard();
}

document.getElementById('balNGNEye')?.addEventListener('click', () => {
  balanceRevealed = !balanceRevealed;
  renderBalanceCard();
});

/* ---------- Transactions ---------- */
function renderTxRow(t) {
  return `
    <tr>
      <td>${esc(t.reference || t.bankReference || '—')}</td>
      <td><span class="status-pill status-${t.status}">${esc(t.status)}</span></td>
      <td>${money(t.amountExpected)}</td>
      <td>${money(t.amountReceived)}</td>
      <td>${fmtDate(t.createdAt)}</td>
    </tr>`;
}

function applyTxFilters() {
  return transactions.filter(t => {
    if (txFilter && t.status !== txFilter) return false;
    if (txSearch) {
      const q = txSearch.toLowerCase();
      const hay = `${t.reference || ''} ${t.bankReference || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTransactions() {
  const filtered = applyTxFilters();
  const tbody = document.querySelector('#txTable tbody');
  const empty = document.getElementById('txEmpty');
  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = filtered.map(renderTxRow).join('');
  }

  // Overview's own "Recent transactions" panel (rtx*) is rendered separately
  // by renderRecentTxV2(), since it has its own search/filter state and
  // customer lookups.
  renderRecentTxV2();
}

function populateRefundTxOptions() {
  const sel = document.getElementById('refTxSelect');
  const refundable = transactions.filter(t => ['success', 'partial', 'over'].includes(t.status));
  sel.innerHTML = '<option value="">Select a refundable transaction…</option>' +
    refundable.map(t => `<option value="${t._id}">${esc(t.reference || t.bankReference || t._id)} — ${money(t.amountReceived)}</option>`).join('');
}

async function loadTransactions() {
  const res = await api(`/api/transactions?mode=${VIEW_MODE}`);
  transactions = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const settled = ['success', 'partial', 'over'];
  const volumeIn = transactions
    .filter(t => settled.includes(t.status))
    .reduce((sum, t) => sum + (t.amountReceived || 0), 0);
  setText('ovTotalValue', money(volumeIn));
  setText('ovTotalValue2', money(volumeIn));
  setText('ovTotalVolume', String(transactions.length));

  const flagged = transactions.filter(t => t.status === 'flagged').length;
  setText('flaggedCount', String(flagged));

  renderTransactions();
  populateRefundTxOptions();
}

/* ---------- Payouts ---------- */
function renderPayouts() {
  const tbody = document.querySelector('#poTable tbody');
  const empty = document.getElementById('poEmpty');
  if (!payouts.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = payouts.map(p => `
    <tr>
      <td>${esc(p.reference)}</td>
      <td><span class="status-pill status-${p.status}">${esc(p.status)}</span></td>
      <td>${money(p.amount)}</td>
      <td>${esc(p.destinationAccountNumber)} (${esc(p.destinationBankCode)})</td>
      <td>${fmtDate(p.createdAt)}</td>
    </tr>`).join('');
}

async function loadPayouts() {
  const res = await api(`/api/payouts?mode=${VIEW_MODE}`);
  payouts = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const paidOut = payouts
    .filter(p => p.status === 'successful')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  setText('ovTotalSettlements', money(paidOut));
  setText('ovTotalSettlements2', money(paidOut));
  setText('payoutCountNote', `${payouts.length} payout${payouts.length === 1 ? '' : 's'}`);

  renderPayouts();
}

/* ---------- Customers ---------- */
function renderCustomers() {
  const tbody = document.querySelector('#custTable tbody');
  const empty = document.getElementById('custEmpty');
  if (!customers.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = customers.map(c => `
      <tr>
        <td>${esc(c.fullName)}</td>
        <td>${esc(c.email)}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${fmtDate(c.createdAt)}</td>
      </tr>`).join('');
  }

  const sel = document.getElementById('subCustomerSelect');
  sel.innerHTML = '<option value="">Select a customer…</option>' +
    customers.map(c => `<option value="${c._id}">${esc(c.fullName)} — ${esc(c.email)}</option>`).join('');
}

async function loadCustomers() {
  const res = await api('/api/customers');
  customers = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  customerById = {};
  customers.forEach((c) => { customerById[c._id] = c; });
  renderCustomers();
}

document.getElementById('customerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fullName = document.getElementById('custName').value.trim();
  const email = document.getElementById('custEmail').value.trim();
  const phone = document.getElementById('custPhone').value.trim();
  try {
    await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ fullName, email, phone: phone || undefined }),
    });
    toast('Customer added');
    e.target.reset();
    await loadCustomers();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

/* ---------- Refunds ---------- */
function renderRefunds() {
  const tbody = document.querySelector('#refTable tbody');
  const empty = document.getElementById('refEmpty');
  if (!refunds.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = refunds.map(r => `
    <tr>
      <td>${esc(r.reference)}</td>
      <td><span class="status-pill status-${r.status}">${esc(r.status)}</span></td>
      <td>${money(r.amount)}</td>
      <td>${esc(r.reason || '—')}</td>
      <td>${fmtDate(r.createdAt)}</td>
    </tr>`).join('');
}

async function loadRefunds() {
  const res = await api('/api/refunds');
  refunds = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderRefunds();
}

document.getElementById('refundForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const transactionId = document.getElementById('refTxSelect').value;
  const nairaAmount = parseFloat(document.getElementById('refAmount').value);
  const reason = document.getElementById('refReason').value.trim();
  const destinationBankCode = document.getElementById('refBankCode').value.trim();
  const destinationAccountNumber = document.getElementById('refAccountNumber').value.trim();
  const destinationAccountName = document.getElementById('refAccountName').value.trim();

  try {
    await api('/api/refunds', {
      method: 'POST',
      body: JSON.stringify({
        transactionId,
        amount: Math.round(nairaAmount * 100),
        reason: reason || undefined,
        destinationBankCode,
        destinationAccountNumber,
        destinationAccountName,
      }),
    });
    toast('Refund submitted');
    e.target.reset();
    await Promise.all([loadRefunds(), loadWallet()]);
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

/* ---------- Disputes ---------- */
function renderDisputes() {
  const tbody = document.querySelector('#disputeTable tbody');
  const empty = document.getElementById('disputeEmpty');
  const openCount = disputes.filter(d => d.status === 'open' || d.status === 'under_review').length;
  const badge = document.getElementById('disputeBadge');
  if (openCount) {
    badge.textContent = openCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  const notifBadge = document.getElementById('notifBadge');
  if (notifBadge) {
    notifBadge.textContent = String(openCount);
    notifBadge.classList.toggle('show', openCount > 0);
  }

  if (!disputes.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = disputes.map(d => `
      <tr>
        <td>${esc(d.disputeCode)}</td>
        <td><span class="status-pill status-${d.status}">${esc(d.status)}</span></td>
        <td>${money(d.amount)}</td>
        <td>${esc(d.reason)}</td>
        <td>${fmtDate(d.evidenceDueBy)}</td>
        <td>${d.evidence?.length ? `${d.evidence.length} submitted` : '—'}</td>
      </tr>`).join('');
  }

  const sel = document.getElementById('evDisputeSelect');
  const respondable = disputes.filter(d => d.status === 'open' || d.status === 'under_review');
  sel.innerHTML = '<option value="">Select a dispute…</option>' +
    respondable.map(d => `<option value="${d._id}">${esc(d.disputeCode)} — ${money(d.amount)}</option>`).join('');
}

async function loadDisputes() {
  const res = await api('/api/disputes');
  disputes = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderDisputes();
}

document.getElementById('evidenceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const disputeId = document.getElementById('evDisputeSelect').value;
  const description = document.getElementById('evDescription').value.trim();
  const url = document.getElementById('evUrl').value.trim();

  try {
    await api(`/api/disputes/${disputeId}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ description, url: url || undefined }),
    });
    toast('Evidence submitted');
    e.target.reset();
    await loadDisputes();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

/* ---------- Subscriptions: plans, subscriptions, invoices ---------- */
function renderPlans() {
  const tbody = document.querySelector('#planTable tbody');
  const empty = document.getElementById('planEmpty');
  if (!plans.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = plans.map(p => `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${money(p.amount)}</td>
        <td>${esc(p.interval)}</td>
        <td><span class="status-pill status-${p.active ? 'active' : 'cancelled'}">${p.active ? 'active' : 'inactive'}</span></td>
      </tr>`).join('');
  }

  const sel = document.getElementById('subPlanSelect');
  const active = plans.filter(p => p.active);
  sel.innerHTML = '<option value="">Select a plan…</option>' +
    active.map(p => `<option value="${p.planCode}">${esc(p.name)} — ${money(p.amount)}/${esc(p.interval)}</option>`).join('');
}

async function loadPlans() {
  const res = await api('/api/subscriptions/plans');
  plans = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderPlans();
}

document.getElementById('planForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('planName').value.trim();
  const nairaAmount = parseFloat(document.getElementById('planAmount').value);
  const interval = document.getElementById('planInterval').value;

  try {
    await api('/api/subscriptions/plans', {
      method: 'POST',
      body: JSON.stringify({ name, amount: Math.round(nairaAmount * 100), currency: 'NGN', interval }),
    });
    toast('Plan created');
    e.target.reset();
    await loadPlans();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

function renderSubscriptions() {
  const tbody = document.querySelector('#subTable tbody');
  const empty = document.getElementById('subEmpty');
  if (!subscriptions.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = subscriptions.map(s => `
    <tr>
      <td>${esc(s.subscriptionCode)}</td>
      <td>${esc(s.plan?.name || '—')}</td>
      <td><span class="status-pill status-${s.status}">${esc(s.status)}</span></td>
      <td>${fmtDate(s.nextBillingDate)}</td>
      <td>${s.status !== 'cancelled' ? `<button class="btn btn-sm btn-danger-outline" data-cancel-sub="${s._id}">Cancel</button>` : ''}</td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-cancel-sub]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const confirmed = window.confirm('Cancel this subscription? The customer will no longer be billed.');
      if (!confirmed) return;
      try {
        await api(`/api/subscriptions/${btn.dataset.cancelSub}/cancel`, { method: 'POST' });
        toast('Subscription cancelled');
        await loadSubscriptions();
      } catch (err) {
        toast(err.message.replace(/_/g, ' '), true);
      }
    });
  });
}

async function loadSubscriptions() {
  const res = await api('/api/subscriptions');
  subscriptions = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderSubscriptions();
}

document.getElementById('subscribeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customerId = document.getElementById('subCustomerSelect').value;
  const planCode = document.getElementById('subPlanSelect').value;

  try {
    await api('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ customerId, planCode }),
    });
    toast('Customer subscribed');
    e.target.reset();
    await loadSubscriptions();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

function renderInvoices() {
  const tbody = document.querySelector('#invTable tbody');
  const empty = document.getElementById('invEmpty');
  if (!invoices.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = invoices.map(i => `
    <tr>
      <td>${esc(i.invoiceNumber)}</td>
      <td><span class="status-pill status-${i.status}">${esc(i.status)}</span></td>
      <td>${money(i.amount)}</td>
      <td>${fmtDate(i.dueDate)}</td>
    </tr>`).join('');
}

async function loadInvoices() {
  const res = await api('/api/subscriptions/invoices');
  invoices = res.data.sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));
  renderInvoices();
}

/* ---------- Subaccounts ---------- */
let subaccounts = [];

function renderSubaccounts() {
  const tbody = document.querySelector('#subaccTable tbody');
  const empty = document.getElementById('subaccEmpty');
  if (!subaccounts.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = subaccounts.map(s => `
    <tr>
      <td>${esc(s.businessName)}</td>
      <td>${esc(s.settlementAccountNumber)} (${esc(s.settlementBankCode)})</td>
      <td>${s.defaultSplitPercentage != null ? s.defaultSplitPercentage + '%' : '—'}</td>
      <td>${fmtDate(s.createdAt)}</td>
      <td><button class="btn btn-sm" data-settle-subacc="${s._id}">Settle</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-settle-subacc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/subaccounts/${btn.dataset.settleSubacc}/settle`, { method: 'POST' });
        toast('Subaccount settled');
        await loadSubaccounts();
      } catch (err) {
        toast(err.message.replace(/_/g, ' '), true);
      }
    });
  });
}

async function loadSubaccounts() {
  const res = await api('/api/subaccounts');
  subaccounts = res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderSubaccounts();
}

document.getElementById('subaccountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const businessName = document.getElementById('subaccName').value.trim();
  const settlementBankCode = document.getElementById('subaccBankCode').value.trim();
  const settlementAccountNumber = document.getElementById('subaccAccountNumber').value.trim();
  const settlementAccountName = document.getElementById('subaccAccountName').value.trim();
  const splitRaw = document.getElementById('subaccSplit').value;
  const defaultSplitPercentage = splitRaw ? parseFloat(splitRaw) : undefined;

  try {
    await api('/api/subaccounts', {
      method: 'POST',
      body: JSON.stringify({
        businessName,
        settlementBankCode,
        settlementAccountNumber,
        settlementAccountName,
        defaultSplitPercentage,
      }),
    });
    toast('Subaccount added');
    e.target.reset();
    await loadSubaccounts();
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

/* ---------- Overview / global refresh ---------- */
async function refreshAll() {
  await Promise.all([
    loadProfile(),
    loadWallet(),
    loadTransactions(),
    loadPayouts(),
    loadCustomers(),
    loadRefunds(),
    loadDisputes(),
    loadPlans(),
    loadSubscriptions(),
    loadInvoices(),
    loadSubaccounts(),
  ]);
  renderCharts();
  renderGreeting();
  renderStatCards();
  renderOverviewAnalytics();
  renderRecentTxV2();
}

/* ---------- Charts (Analytics tab) ---------- */
let _chartAnBar = null;
let _chartAnCandle = null;

function dayKey(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
}

function lastNDays(n) {
  const days = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  return days;
}

const SETTLED_STATUSES = ['success', 'partial', 'over'];

function buildDailySeries(days) {
  // Returns { received: {day: minorTotal}, paid: {day: minorTotal}, count: {day: txCount}, ohlc: {day: {o,h,l,c}} }
  const received = {};
  const paid = {};
  const count = {};
  const ohlc = {};
  days.forEach(d => { received[d] = 0; paid[d] = 0; count[d] = 0; });

  transactions.forEach(t => {
    const key = dayKey(t.createdAt);
    if (key in count) count[key] += 1;

    if (!SETTLED_STATUSES.includes(t.status)) return;
    const amt = (t.amountReceived || 0) / 100;
    if (key in received) received[key] += amt;

    if (!ohlc[key]) ohlc[key] = { o: amt, h: amt, l: amt, c: amt };
    else {
      const row = ohlc[key];
      row.h = Math.max(row.h, amt);
      row.l = Math.min(row.l, amt);
      row.c = amt; // transactions arrive sorted newest-first, so last write = earliest amount for the day; fine as an approximation of "close"
    }
  });

  payouts.forEach(p => {
    if (p.status !== 'successful') return;
    const key = dayKey(p.createdAt);
    if (key in paid) paid[key] += (p.amount || 0) / 100;
  });

  return { received, paid, count, ohlc };
}

function renderCharts() {
  if (typeof Chart === 'undefined') return; // CDN blocked / offline — charts simply don't render

  const days30 = lastNDays(30);
  const series30 = buildDailySeries(days30);

  const shortLabel = (d) => new Date(d).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' });


  // ---- Analytics: 30-day bar (received vs paid out) ----
  const anBarCanvas = document.getElementById('anBarChart');
  if (anBarCanvas) {
    if (_chartAnBar) _chartAnBar.destroy();
    _chartAnBar = new Chart(anBarCanvas, {
      type: 'bar',
      data: {
        labels: days30.map(shortLabel),
        datasets: [
          {
            label: 'Received',
            data: days30.map(d => series30.received[d]),
            backgroundColor: '#0ea5e9',
            borderRadius: 3,
            maxBarThickness: 14,
          },
          {
            label: 'Paid out',
            data: days30.map(d => series30.paid[d]),
            backgroundColor: '#7c3aed',
            borderRadius: 3,
            maxBarThickness: 14,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { beginAtZero: true, ticks: { callback: (v) => '₦' + v.toLocaleString() } },
        },
      },
    });
  }

  // ---- Analytics: candlestick (OHLC per day) ----
  const anCandleCanvas = document.getElementById('anCandleChart');
  if (anCandleCanvas) {
    const candleData = days30
      .filter(d => series30.ohlc[d])
      .map(d => ({
        x: new Date(d).getTime(),
        o: series30.ohlc[d].o,
        h: series30.ohlc[d].h,
        l: series30.ohlc[d].l,
        c: series30.ohlc[d].c,
      }));

    if (_chartAnCandle) _chartAnCandle.destroy();

    try {
      _chartAnCandle = new Chart(anCandleCanvas, {
        type: 'candlestick',
        data: { datasets: [{ label: 'Transaction range (₦)', data: candleData }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { x: { type: 'time', time: { unit: 'day' } } },
        },
      });
    } catch (e) {
      // financial plugin failed to load (offline/CDN blocked) — fall back to a line of daily closes
      _chartAnCandle = new Chart(anCandleCanvas, {
        type: 'line',
        data: {
          labels: candleData.map(p => new Date(p.x).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' })),
          datasets: [{
            label: 'Daily close (₦)',
            data: candleData.map(p => p.c),
            borderColor: '#0ea5e9',
            backgroundColor: 'rgba(14,165,233,0.12)',
            fill: true,
            tension: 0.25,
          }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    }
  }

  renderInsights();
}

function renderInsights() {
  const settled = transactions.filter(t => SETTLED_STATUSES.includes(t.status));
  const avg = settled.length
    ? settled.reduce((s, t) => s + (t.amountReceived || 0), 0) / settled.length
    : 0;
  const successRate = transactions.length
    ? Math.round((settled.length / transactions.length) * 100)
    : 0;

  const days30set = new Set(lastNDays(30));
  const dayCounts = {};
  transactions.forEach(t => {
    const key = dayKey(t.createdAt);
    if (days30set.has(key)) dayCounts[key] = (dayCounts[key] || 0) + 1;
  });
  let busiestDay = '—';
  let busiestCount = 0;
  Object.entries(dayCounts).forEach(([d, c]) => {
    if (c > busiestCount) { busiestCount = c; busiestDay = d; }
  });

  const refundRate = settled.length
    ? Math.round((refunds.length / settled.length) * 100)
    : 0;

  const openDisputes = disputes.filter(d => ['open', 'under_review'].includes(d.status)).length;
  const activeSubs = subscriptions.filter(s => s.status === 'active').length;

  setText('anAvgVal', money(avg));
  setText('anSuccessRate', transactions.length ? `${successRate}%` : '—');
  setText('anBusiestDay', busiestCount ? `${new Date(busiestDay).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' })} (${busiestCount})` : '—');
  setText('anRefundRate', settled.length ? `${refundRate}%` : '—');
  setText('anOpenDisputes', String(openDisputes));
  setText('anActiveSubs', String(activeSubs));

  const emptyNote = document.getElementById('anEmptyNote');
  if (emptyNote) emptyNote.style.display = transactions.length ? 'none' : 'flex';
}

/* ---------- Event wiring: existing panels ---------- */
async function performLogout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/onboarding.html?tab=login';
}

document.getElementById('logoutBtn').addEventListener('click', performLogout);
document.getElementById('topLogoutBtn')?.addEventListener('click', performLogout);

/* ---------- Topbar avatar -> logout dropdown ---------- */
(function wireUserMenu() {
  const menu = document.getElementById('topUserMenu');
  const trigger = document.getElementById('topUserChipBtn');
  if (!menu || !trigger) return;

  const close = () => { menu.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); };
  const open = () => { menu.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('open') ? close() : open();
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
})();

document.getElementById('webhookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const webhookUrl = document.getElementById('webhookUrlInput').value.trim();
  try {
    await api('/api/merchant/webhook-url', { method: 'PATCH', body: JSON.stringify({ webhookUrl }) });
    toast('Webhook URL saved');
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

document.getElementById('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('linkAmount').value);
  const email = document.getElementById('linkEmail').value.trim();
  const name = document.getElementById('linkName').value.trim();

  try {
    const res = await api('/api/payments/initialize', {
      method: 'POST',
      body: JSON.stringify({ amount, customer: { email, name: name || undefined } }),
    });
    document.getElementById('linkResult').innerHTML = `
      <div class="link-card">
        <div class="key-row">
          <div class="k-label">Payment link</div>
          <div class="link-row">
            <div class="k-val" id="genLink">${esc(res.data.link)}</div>
            <button type="button" class="btn btn-sm copy-btn" id="copyLinkBtn">Copy</button>
          </div>
        </div>
        <div class="key-row" style="margin-top:10px;">
          <div class="k-label">Virtual account</div>
          <div class="k-val">${esc(res.data.accountNumber)}</div>
        </div>
      </div>`;
    document.getElementById('copyLinkBtn').addEventListener('click', () => copyToClipboard(res.data.link));
    toast('Payment link generated');
    await Promise.all([loadTransactions(), loadCustomers()]);
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

document.getElementById('payoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nairaAmount = parseFloat(document.getElementById('poAmount').value);
  const destinationBankCode = document.getElementById('poBankCode').value.trim();
  const destinationAccountNumber = document.getElementById('poAccountNumber').value.trim();
  const destinationAccountName = document.getElementById('poAccountName').value.trim();

  try {
    await api('/api/payouts', {
      method: 'POST',
      body: JSON.stringify({
        amount: Math.round(nairaAmount * 100),
        destinationBankCode,
        destinationAccountNumber,
        destinationAccountName,
      }),
    });
    toast('Payout submitted');
    e.target.reset();
    await Promise.all([loadPayouts(), loadWallet()]);
  } catch (err) {
    toast(err.message.replace(/_/g, ' '), true);
  }
});

function wireRegenButton(btnId, resultId, mode) {
  document.getElementById(btnId).addEventListener('click', async () => {
    const confirmed = window.confirm(
      `Generate a new ${mode} secret key? Your current ${mode} key will stop working ` +
      'immediately — update it anywhere you use it before continuing.'
    );
    if (!confirmed) return;

    try {
      const res = await api('/api/merchant/regenerate-key', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      const resultBox = document.getElementById(resultId);
      const valId = `${resultId}Val`;
      const copyId = `${resultId}Copy`;
      resultBox.innerHTML = `
        <div class="key-reveal">
          <div class="warn">Store this now — it will not be shown again.</div>
          <div class="key-row">
            <div class="k-label">${mode} secret key</div>
            <div class="link-row">
              <div class="k-val" id="${valId}">${esc(res.data.secretKey)}</div>
              <button type="button" class="btn btn-sm copy-btn" id="${copyId}">Copy</button>
            </div>
          </div>
        </div>`;
      document.getElementById(copyId).addEventListener('click', () => copyToClipboard(res.data.secretKey));
      toast(`New ${mode} secret key generated`);
    } catch (err) {
      toast(err.message.replace(/_/g, ' '), true);
    }
  });
}

wireRegenButton('regenTestKeyBtn', 'regenTestKeyResult', 'test');
wireRegenButton('regenLiveKeyBtn', 'regenLiveKeyResult', 'live');

document.getElementById('qaPosBtn')?.addEventListener('click', () => {
  toast('POS terminals — coming soon');
});

document.getElementById('qaLinkBtn')?.addEventListener('click', () => {
  const amt = document.getElementById('linkAmount');
  if (amt) {
    amt.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => amt.focus(), 300);
  }
});

document.querySelectorAll('#txFilters .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#txFilters .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    txFilter = chip.dataset.status;
    renderTransactions();
  });
});

document.getElementById('txSearch').addEventListener('input', (e) => {
  txSearch = e.target.value.trim();
  renderTransactions();
});

/* ================= Overview v2: stat cards, analytics chart, recent tx ================= */

function computeTrend(curVal, prevVal) {
  if (!prevVal) return { pct: curVal ? 100 : 0, dir: curVal > 0 ? 'up' : 'flat' };
  const pct = ((curVal - prevVal) / Math.abs(prevVal)) * 100;
  return { pct: Math.abs(pct), dir: pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat' };
}

function renderTrend(id, trend) {
  const el = document.getElementById(id);
  if (!el) return;
  const arrow = trend.dir === 'up' ? '↗' : trend.dir === 'down' ? '↘' : '→';
  el.innerHTML = `<span class="trend-badge ${trend.dir}">${arrow} ${trend.pct.toFixed(1)}%</span><span class="trend-note">vs previous period</span>`;
}

function inRange(d, start, end) {
  const t = new Date(d).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function ovRangeBounds() {
  const now = new Date();
  let start;
  let end = now;
  if (ovRange === 'today') {
    start = new Date(now); start.setHours(0, 0, 0, 0);
  } else if (ovRange === '7d') {
    start = new Date(now.getTime() - 7 * 86400000);
  } else if (ovRange === '30d') {
    start = new Date(now.getTime() - 30 * 86400000);
  } else if (ovRange === 'custom' && ovCustomStart && ovCustomEnd) {
    start = new Date(ovCustomStart); start.setHours(0, 0, 0, 0);
    end = new Date(ovCustomEnd); end.setHours(23, 59, 59, 999);
  } else {
    start = new Date(now); start.setHours(0, 0, 0, 0);
  }
  const spanMs = Math.max(end.getTime() - start.getTime(), 1);
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - spanMs);
  return { start, end, prevStart, prevEnd };
}

function renderGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const period = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  setText('ovGreetPeriod', period);
  setText('ovDateLabel', now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase());
  const rangeWord = ovRange === 'today' ? 'today'
    : ovRange === '7d' ? 'in the last 7 days'
    : ovRange === '30d' ? 'in the last 30 days'
    : 'in the selected period';
  setText('ovSubRangeWord', rangeWord);
}

function renderStatCards() {
  const { start, end, prevStart, prevEnd } = ovRangeBounds();
  const curTx = transactions.filter(t => inRange(t.createdAt, start, end));
  const prevTx = transactions.filter(t => inRange(t.createdAt, prevStart, prevEnd));
  const collected = (list) => list
    .filter(t => SETTLED_STATUSES.includes(t.status))
    .reduce((s, t) => s + (t.amountReceived || 0), 0);

  const curCollected = collected(curTx);
  const prevCollected = collected(prevTx);
  const curPayouts = payouts
    .filter(p => p.status === 'successful' && inRange(p.createdAt, start, end))
    .reduce((s, p) => s + (p.amount || 0), 0);

  // Available balance
  setText('statAvailable', walletBalanceMinor == null ? '—' : money(walletBalanceMinor));
  if (walletBalanceMinor != null) {
    const approxPrevBalance = walletBalanceMinor - (curCollected - curPayouts);
    renderTrend('statAvailableTrend', computeTrend(walletBalanceMinor, approxPrevBalance));
  }

  // Pending balance (live wallet figure, trend derived from pending-status volume this period vs last)
  setText('statPending', walletPendingMinor == null ? '—' : money(walletPendingMinor));
  const curPendingVol = curTx.filter(t => t.status === 'pending').reduce((s, t) => s + (t.amountExpected || t.amountReceived || 0), 0);
  const prevPendingVol = prevTx.filter(t => t.status === 'pending').reduce((s, t) => s + (t.amountExpected || t.amountReceived || 0), 0);
  renderTrend('statPendingTrend', computeTrend(curPendingVol, prevPendingVol));

  // Total collected + total transactions, both scoped to the selected range
  setText('statCollected', money(curCollected));
  renderTrend('statCollectedTrend', computeTrend(curCollected, prevCollected));

  setText('statTxCount', curTx.length.toLocaleString());
  renderTrend('statTxCountTrend', computeTrend(curTx.length, prevTx.length));
}

function compactNum(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'b';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

let _chartOvAnalytics = null;

function renderOverviewAnalytics() {
  if (typeof Chart === 'undefined') return;
  const canvas = document.getElementById('ovAnalyticsChart');
  if (!canvas) return;

  const days = lastNDays(ovSpanDays);
  const now = new Date();
  const prevDays = [];
  for (let i = ovSpanDays * 2 - 1; i >= ovSpanDays; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    prevDays.push(dayKey(d));
  }

  const curSeries = buildDailySeries(days);
  const prevSeries = buildDailySeries(prevDays);

  const pick = (series, day) => (ovMetric === 'volume' ? (series.received[day] || 0) : (series.count[day] || 0));
  const curVals = days.map(d => pick(curSeries, d));
  const prevVals = prevDays.map(d => pick(prevSeries, d));

  const totalCur = curVals.reduce((a, b) => a + b, 0);
  const totalPrev = prevVals.reduce((a, b) => a + b, 0);
  const trend = computeTrend(totalCur, totalPrev);

  setText('ovBigNum', ovMetric === 'volume' ? `₦${compactNum(totalCur)}` : totalCur.toLocaleString());
  const bigTrendEl = document.getElementById('ovBigTrend');
  if (bigTrendEl) {
    const arrow = trend.dir === 'up' ? '↗' : trend.dir === 'down' ? '↘' : '→';
    bigTrendEl.textContent = `${arrow} ${trend.pct.toFixed(1)}%`;
    bigTrendEl.className = `big-trend ${trend.dir}`;
  }

  const labelFmt = ovSpanDays <= 30
    ? (d) => new Date(d).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' })
    : (d) => new Date(d).toLocaleDateString('en-NG', { month: 'short', year: '2-digit' });

  if (_chartOvAnalytics) _chartOvAnalytics.destroy();
  _chartOvAnalytics = new Chart(canvas, {
    type: 'line',
    data: {
      labels: days.map(labelFmt),
      datasets: [
        {
          label: 'Current period', data: curVals,
          borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.12)',
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
        {
          label: 'Previous period', data: prevVals,
          borderColor: '#cbd5e1', backgroundColor: 'transparent',
          borderDash: [4, 4], fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, ticks: { callback: (v) => (ovMetric === 'volume' ? '₦' + compactNum(v) : v) } },
      },
    },
  });
}

function displayStatus(t) {
  if ((t.refundedAmount || 0) > 0 && t.refundedAmount >= t.amountReceived) return 'refunded';
  return t.status;
}

const AVATAR_PALETTE = ['#0ea5e9', '#7c3aed', '#f59e0b', '#16a34a', '#ec4899', '#0891b2', '#dc2626', '#6366f1'];
function avatarColorFor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

const PAYMENT_METHOD_LABEL = {
  dedicated_virtual_account: 'Virtual Account',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  ussd: 'USSD',
};

function renderRtxRow(t) {
  const cust = customerById[t.customer];
  const name = cust?.fullName || 'Unknown customer';
  const email = cust?.email || '';
  const init = initialsFor(name);
  const color = avatarColorFor(cust?._id || t.customer || name);
  const ds = displayStatus(t);
  const methodLabel = PAYMENT_METHOD_LABEL[t.channel] || 'Virtual Account';
  return `
    <tr>
      <td>
        <div class="cust-cell">
          <span class="cust-avatar" style="background:${color}">${esc(init)}</span>
          <div class="cust-who">
            <span class="cust-name">${esc(name)}</span>
            <span class="cust-email">${esc(email)}</span>
          </div>
        </div>
      </td>
      <td>${money(t.amountReceived)}</td>
      <td><span class="status-pill status-${ds}">${esc(ds)}</span></td>
      <td>${esc(methodLabel)}</td>
      <td>${fmtDate(t.createdAt)}</td>
      <td class="mono-cell">${esc(t.reference || t.bankReference || '—')}</td>
    </tr>`;
}

function renderRecentTxV2() {
  const tbody = document.querySelector('#rtxTable tbody');
  const empty = document.getElementById('rtxEmpty');
  if (!tbody) return;

  let list = transactions;
  if (rtxStatusFilter) list = list.filter(t => displayStatus(t) === rtxStatusFilter);
  if (rtxSearch) {
    const q = rtxSearch.toLowerCase();
    list = list.filter((t) => {
      const cust = customerById[t.customer];
      const hay = `${t.reference || ''} ${t.bankReference || ''} ${cust?.fullName || ''} ${cust?.email || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  setText('rtxTotalCount', transactions.length ? `${transactions.length.toLocaleString()} total` : '');

  const shown = list.slice(0, 6);
  if (!shown.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = shown.map(renderRtxRow).join('');
  }
  setText('rtxShowingText', list.length
    ? `Showing 1–${shown.length} of ${list.length.toLocaleString()} transactions`
    : 'No matching transactions');
}

/* ---------- Overview v2 event wiring ---------- */
document.querySelectorAll('#ovRangeTabs .range-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.range === 'custom') {
      const box = document.getElementById('ovCustomRange');
      if (box) box.style.display = box.style.display === 'none' ? 'flex' : 'none';
      return;
    }
    const box = document.getElementById('ovCustomRange');
    if (box) box.style.display = 'none';
    document.querySelectorAll('#ovRangeTabs .range-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ovRange = btn.dataset.range;
    renderGreeting();
    renderStatCards();
  });
});

document.getElementById('ovCustomApply')?.addEventListener('click', () => {
  const s = document.getElementById('ovCustomStart').value;
  const e = document.getElementById('ovCustomEnd').value;
  if (!s || !e) { toast('Pick a start and end date', true); return; }
  ovCustomStart = s;
  ovCustomEnd = e;
  ovRange = 'custom';
  document.querySelectorAll('#ovRangeTabs .range-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('#ovRangeTabs .range-tab[data-range="custom"]')?.classList.add('active');
  renderGreeting();
  renderStatCards();
});

document.querySelectorAll('#ovMetricToggle .seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ovMetricToggle .seg').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ovMetric = btn.dataset.metric;
    renderOverviewAnalytics();
  });
});

document.querySelectorAll('#ovSpanToggle .seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ovSpanToggle .seg').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ovSpanDays = parseInt(btn.dataset.span, 10);
    renderOverviewAnalytics();
  });
});

document.getElementById('rtxSearch')?.addEventListener('input', (e) => {
  rtxSearch = e.target.value.trim();
  renderRecentTxV2();
});

document.getElementById('rtxStatusFilter')?.addEventListener('change', (e) => {
  rtxStatusFilter = e.target.value;
  renderRecentTxV2();
});

document.getElementById('rtxExportBtn')?.addEventListener('click', () => {
  const rows = Array.from(document.querySelectorAll('#rtxTable tbody tr'));
  if (!rows.length) { toast('No transactions to export', true); return; }
  const headers = Array.from(document.querySelectorAll('#rtxTable thead th')).map(th => th.textContent.trim());
  const csvRows = [headers.join(',')];
  rows.forEach((tr) => {
    const cells = Array.from(tr.children).map((td) => `"${td.textContent.trim().replace(/"/g, '""')}"`);
    csvRows.push(cells.join(','));
  });
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `swiftpay-recent-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

renderGreeting();

refreshAll().catch((err) => {
  if (err.message !== 'unauthenticated') toast(err.message, true);
});
