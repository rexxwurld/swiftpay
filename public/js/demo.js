async function startDemoCheckout({ amount, name, email, phone }) {
  const res = await fetch('/api/demo/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, name, email, phone }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw new Error(body.message || `request_failed_${res.status}`);
  }
  return body.data;
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.getElementById('demoAmount').value = chip.dataset.amount;
  });
});

document.getElementById('demoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById('errorBox');
  const btn = document.getElementById('startBtn');
  errorBox.classList.remove('show');

  const amount = parseFloat(document.getElementById('demoAmount').value);
  const name = document.getElementById('demoName').value.trim();
  const email = document.getElementById('demoEmail').value.trim();
  const phone = document.getElementById('demoPhone').value.trim();

  if (!amount || amount <= 0) {
    errorBox.textContent = 'Enter an amount greater than zero.';
    errorBox.classList.add('show');
    return;
  }
  if (!name) {
    errorBox.textContent = 'Enter your name.';
    errorBox.classList.add('show');
    return;
  }
  if (!email) {
    errorBox.textContent = 'Enter your email.';
    errorBox.classList.add('show');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Setting up your demo…';

  try {
    const data = await startDemoCheckout({ amount, name, email, phone });
    // The demo checkout is a normal test-mode checkout - /pay/:token
    // is already public and lets the visitor simulate the bank
    // transfer themselves from there.
    window.location.href = data.link;
  } catch (err) {
    errorBox.textContent = err.message.replace(/_/g, ' ');
    errorBox.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Start demo checkout';
  }
});
