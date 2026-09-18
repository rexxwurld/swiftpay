
  const tabRegister = document.getElementById('tab-register');
  const tabLogin = document.getElementById('tab-login');
  const registerForm = document.getElementById('registerForm');
  const loginForm = document.getElementById('loginForm');
  const errBox = document.getElementById('err');
  const keyReveal = document.getElementById('keyReveal');
  const passwordInput = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirmPassword');
  const passwordMismatch = document.getElementById('passwordMismatch');
  const planSelect = document.getElementById('plan');

  function showTab(name) {
    const isRegister = name === 'register';
    tabRegister.classList.toggle('active', isRegister);
    tabLogin.classList.toggle('active', !isRegister);
    registerForm.style.display = isRegister ? 'block' : 'none';
    loginForm.style.display = isRegister ? 'none' : 'block';
    keyReveal.style.display = 'none';
    errBox.classList.remove('show');
  }
  tabRegister.addEventListener('click', () => showTab('register'));
  tabLogin.addEventListener('click', () => showTab('login'));
  document.querySelectorAll('.switch-link').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showTab(el.dataset.tab);
    });
  });

  const params = new URLSearchParams(location.search);
  showTab(params.get('tab') === 'login' ? 'login' : 'register');

  // Preselect plan from ?plan= (e.g. the pricing section on the homepage)
  const requestedPlan = params.get('plan');
  if (requestedPlan && planSelect && [...planSelect.options].some((o) => o.value === requestedPlan)) {
    planSelect.value = requestedPlan;
  }

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.add('show');
  }

  function passwordsMatch() {
    const match = passwordInput.value === confirmPasswordInput.value;
    passwordMismatch.classList.toggle('show', !match);
    return match;
  }
  confirmPasswordInput.addEventListener('input', passwordsMatch);
  passwordInput.addEventListener('input', () => {
    if (confirmPasswordInput.value) passwordsMatch();
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.remove('show');

    if (!passwordsMatch()) {
      showError('Passwords don\'t match.');
      return;
    }

    const data = Object.fromEntries(new FormData(registerForm));
    delete data.confirmPassword; // not a real form field, but guard anyway
    try {
      const res = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(data) });
      document.getElementById('revealSecret').textContent = res.data.testSecretKey;
      document.getElementById('revealWebhookSecret').textContent = res.data.webhookSecret;
      registerForm.style.display = 'none';
      keyReveal.style.display = 'block';
    } catch (err) {
      showError(err.message.replace(/_/g, ' '));
    }
  });

  document.getElementById('continueBtn').addEventListener('click', () => {
    showTab('login');
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.remove('show');
    const data = Object.fromEntries(new FormData(loginForm));
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
      window.location.href = '/dashboard.html';
    } catch (err) {
      showError(err.message.replace(/_/g, ' '));
    }
  });
