  /*
   * URL format:
   *
   * https://yourdomain.com/pay/<random-checkout-token>
   *
   * Nothing else is exposed.
   */

  const pathParts =
    window.location.pathname
      .split('/')
      .filter(Boolean);

  const payIndex =
    pathParts.indexOf('pay');

  const checkoutToken =
    payIndex !== -1
      ? pathParts[payIndex + 1]
      : null;


  const amountEl =
    document.getElementById('payAmount');

  const bankEl =
    document.getElementById('bankName');

  const numEl =
    document.getElementById('acctNumber');

  const acctBox =
    document.getElementById('acctBox');

  const copyHint =
    document.getElementById('copyHint');

  const statusText =
    document.getElementById('statusText');

  const payCard =
    document.getElementById('payCard');

  const testBanner =
    document.getElementById('testBanner');

  const simulateBtn =
    document.getElementById('simulateBtn');

  const simulateHint =
    document.getElementById('simulateHint');


  let polling = null;
  let testModeUiShown = false;
  let simulateInFlight = false;


  function showTestModeUi() {
    if (testModeUiShown) {
      return;
    }

    testModeUiShown = true;

    testBanner.style.display = 'block';
    simulateBtn.style.display = 'block';
    simulateHint.style.display = 'block';
  }


  async function simulateTransfer() {
    if (simulateInFlight || !checkoutToken) {
      return;
    }

    simulateInFlight = true;
    simulateBtn.disabled = true;
    simulateBtn.textContent = 'Simulating…';

    try {
      const res = await fetch(
        `/api/checkout/${encodeURIComponent(
          checkoutToken
        )}/simulate`,
        {
          method: 'POST',
        }
      );

      const body = await res.json();

      if (!body.status) {
        simulateBtn.disabled = false;
        simulateBtn.textContent = 'Simulate bank transfer';
        simulateHint.textContent =
          body.message === 'account_is_not_currently_awaiting_a_payment'
            ? 'This payment already went through.'
            : 'Could not simulate this transfer. Try again.';
        simulateInFlight = false;
        return;
      }

      // The next scheduled poll() picks up the resulting status and
      // shows the success screen - nothing else to do here.
    } catch (err) {
      simulateBtn.disabled = false;
      simulateBtn.textContent = 'Simulate bank transfer';
      simulateInFlight = false;
    }
  }


  simulateBtn.addEventListener(
    'click',
    simulateTransfer
  );


  function money(minor) {
    if (
      minor === null ||
      minor === undefined
    ) {
      return '—';
    }

    return '₦' +
      (minor / 100).toLocaleString(
        'en-NG',
        {
          minimumFractionDigits: 2,
        }
      );
  }


  acctBox.addEventListener(
    'click',
    () => {
      const num =
        numEl.textContent.trim();

      if (!num || num === '—') {
        return;
      }

      navigator.clipboard
        ?.writeText(num)
        .then(() => {
          copyHint.textContent = 'Copied!';

          setTimeout(
            () => {
              copyHint.textContent =
                'Tap to copy account number';
            },
            1500
          );
        });
    }
  );


  function showSuccess() {
    clearInterval(polling);

    payCard.innerHTML = `
      <div class="success-check">✓</div>

      <h2 style="margin:0 0 6px;">
        Payment received
      </h2>

      <p style="color:var(--ink-dim);font-size:13.5px;">
        Redirecting you back…
      </p>
    `;

    setTimeout(
      () => {
        /*
         * The merchant redirect URL is NOT in this page's URL.
         * SwiftPay resolves it server-side.
         */
        window.location.href =
          `/api/checkout/${encodeURIComponent(
            checkoutToken
          )}/complete`;
      },
      1400
    );
  }


  async function poll() {
    if (!checkoutToken) {
      payCard.innerHTML = `
        <p style="color:var(--red);">
          Invalid payment link.
        </p>
      `;

      return;
    }

    try {

      const res = await fetch(
        `/api/checkout/${encodeURIComponent(
          checkoutToken
        )}/status`,
        {
          method: 'GET',
          cache: 'no-store',
        }
      );


      const body =
        await res.json();


      if (!body.status) {

        if (
          body.message ===
          'checkout_expired'
        ) {
          clearInterval(polling);

          statusText.textContent =
            'This payment link has expired.';

          return;
        }

        return;
      }


      const d = body.data;


      if (d.mode === 'test') {
        showTestModeUi();
      }


      bankEl.textContent =
        d.bankName
          ? `Transfer to ${d.bankName}`
          : 'Transfer to this account';


      numEl.textContent =
        d.accountNumber || '—';


      amountEl.textContent =
        money(d.amountExpected);


      if (
        d.paymentStatus === 'success' ||
        d.paymentStatus === 'over'
      ) {

        showSuccess();

      }

      else if (
        d.paymentStatus === 'flagged'
      ) {

        statusText.textContent =
          'Under review — check back shortly';

      }

      else if (
        d.paymentStatus === 'partial'
      ) {

        statusText.textContent =
          'Payment partially received. Waiting for the balance…';

      }

      else if (
        d.paymentStatus === 'failed'
      ) {

        statusText.textContent =
          'Payment failed. Contact support.';

        clearInterval(polling);

      }

    } catch (err) {

      // Temporary network failure.
      // The next polling attempt will retry.

    }
  }


  if (!checkoutToken) {

    payCard.innerHTML = `
      <p style="color:var(--red);">
        Invalid payment link.
      </p>
    `;

  } else {

    poll();

    polling =
      setInterval(
        poll,
        4000
      );

  }
