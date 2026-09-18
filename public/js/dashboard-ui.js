  // ---- Purely additive UI affordances layered on top of dashboard.js ----
  // (mobile drawer, page title/crumb sync, avatar initial, CSV export)
  (function () {
    const TAB_LABELS = {
      overview: 'Overview', transactions: 'Transactions', customers: 'Customers',
      balances: 'Balances', store: 'Store', payments: 'Payouts',
      subaccounts: 'Subaccounts', settings: 'Settings',
    };

    function syncHeader(name) {
      const title = document.getElementById('pageTitle');
      const crumb = document.getElementById('crumbLabel');
      const label = TAB_LABELS[name] || 'Overview';
      // The Overview tab now carries its own "Good morning, {name}" greeting
      // inside the tab body, so the shared page-head just shows a plain label.
      if (title) title.textContent = label;
      if (crumb) crumb.textContent = '/ ' + label;
    }

    document.querySelectorAll('.side-link[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        syncHeader(btn.dataset.tab);
        closeDrawer();
      });
    });
    document.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => syncHeader(btn.dataset.goto));
    });

    // Mobile drawer
    const drawer = document.getElementById('sidebarDrawer');
    const backdrop = document.getElementById('sidebarBackdrop');
    const toggle = document.getElementById('sidebarToggle');
    function openDrawer() { drawer.classList.add('open'); backdrop.classList.add('open'); }
    function closeDrawer() { drawer.classList.remove('open'); backdrop.classList.remove('open'); }
    if (toggle) toggle.addEventListener('click', () => {
      drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });
    if (backdrop) backdrop.addEventListener('click', closeDrawer);

    // Avatar initial (loadProfile already fills #bizName/#bizEmail)
    const nameEl = document.getElementById('bizName');
    if (nameEl) {
      const obs = new MutationObserver(() => {
        const initial = (nameEl.textContent || '?').trim().charAt(0).toUpperCase();
        const av = document.getElementById('avatarInitial');
        if (av) av.textContent = initial || '?';
      });
      obs.observe(nameEl, { childList: true, characterData: true, subtree: true });
    }

    // Quick "New payment link" button -> overview tab + focus amount field
    const quickLinkBtn = document.getElementById('quickNewLinkBtn');
    if (quickLinkBtn) {
      quickLinkBtn.addEventListener('click', () => {
        const overviewLink = document.querySelector('.side-link[data-tab="overview"]');
        if (overviewLink) overviewLink.click();
        const amt = document.getElementById('linkAmount');
        if (amt) setTimeout(() => amt.focus(), 50);
      });
    }

    // CSV export of the currently visible/filtered transactions table
    const exportBtn = document.getElementById('exportTxBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const rows = Array.from(document.querySelectorAll('#txTable tbody tr'));
        if (!rows.length) {
          const t = document.getElementById('toast');
          if (t) { t.textContent = 'No transactions to export'; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }
          return;
        }
        const headers = Array.from(document.querySelectorAll('#txTable thead th')).map(th => th.textContent.trim());
        const csvRows = [headers.join(',')];
        rows.forEach(tr => {
          const cells = Array.from(tr.children).map(td => {
            const text = td.textContent.trim().replace(/"/g, '""');
            return `"${text}"`;
          });
          csvRows.push(cells.join(','));
        });
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `swiftpay-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
    }
  })();
