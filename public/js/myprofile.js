document.addEventListener('DOMContentLoaded', () => {
  const byId = (id) => document.getElementById(id);
  const menuIcon = byId('menuIcon');
  const sidebar = byId('sidebar');
  const isMobile = () => document.documentElement.clientWidth <= 900;

  function closeSidebar() {
    sidebar.classList.remove('active');
    menuIcon.classList.remove('active');
  }

  // Hamburger toggle
  menuIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('active');
    menuIcon.classList.toggle('active');
  });

  // Close sidebar on click outside
  document.addEventListener('click', (e) => {
    if (isMobile() && sidebar.classList.contains('active') && !e.target.closest('#menuIcon')) {
      closeSidebar();
    }
  });

  // Sidebar links close the sidebar on mobile
  sidebar.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      if (isMobile()) closeSidebar();
    });
  });

  // ===================== Load profile data =====================
  const fullname = localStorage.getItem('fullname') || 'Not set';
  const email = localStorage.getItem('email') || 'Not set';
  const profilePic = localStorage.getItem('profilePic');

  byId('fullName').textContent = fullname;
  byId('email').textContent = email;

  if (profilePic) {
    byId('sidebarProfilePic').src = profilePic;
    byId('mainProfilePic').src = profilePic;
  }

  // ===================== Email badge + verify button =====================
  function updateEmailStatus() {
    const badgeContainer = byId('emailBadge');
    badgeContainer.replaceChildren();

    if (localStorage.getItem('emailVerified') === 'true') {
      badgeContainer.textContent = 'Verified ✅';
      badgeContainer.style.color = 'green';
      badgeContainer.style.fontWeight = '600';
      return;
    }

    const badge = document.createElement('span');
    badge.textContent = 'Unverified ❌';
    Object.assign(badge.style, { color: '#ef4444', fontWeight: '600', marginRight: '10px' });

    const verifyBtn = document.createElement('button');
    verifyBtn.textContent = 'Click to verify';
    Object.assign(verifyBtn.style, {
      padding: '2px 6px',
      fontSize: '0.8rem',
      cursor: 'pointer',
      border: '1px solid #3b82f6',
      borderRadius: '4px',
      background: '#fff',
      color: '#3b82f6',
    });
    verifyBtn.addEventListener('click', () => {
      localStorage.setItem('emailVerified', 'true');
      updateEmailStatus();
      alert('Email verified! ✅');
    });

    badgeContainer.append(badge, verifyBtn);
  }
  updateEmailStatus();

  // ===================== Logout =====================
  byId('logoutBtn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = '/onboarding?tab=login';
  });
});
