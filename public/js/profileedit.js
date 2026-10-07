document.addEventListener('DOMContentLoaded', () => {
  const byId = (id) => document.getElementById(id);
  const menuIcon = byId('menuIcon');
  const sidebar = byId('sidebar');
  const isMobile = () => document.documentElement.clientWidth <= 900;

  function closeSidebar() {
    sidebar.classList.remove('active');
    menuIcon.classList.remove('active');
  }

  // ===================== Hamburger toggle =====================
  menuIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('active');
    menuIcon.classList.toggle('active');
  });

  document.addEventListener('click', (e) => {
    if (isMobile() && sidebar.classList.contains('active') && !e.target.closest('#menuIcon')) {
      closeSidebar();
    }
  });

  sidebar.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      if (isMobile()) closeSidebar();
    });
  });

  // ===================== Load profile info =====================
  // Passwords are never stored client-side. Purge any copy saved by older versions.
  localStorage.removeItem('password');

  const fullnameInput = byId('fullname');
  const emailInput = byId('email');
  const savedName = localStorage.getItem('fullname') || '';
  const savedEmail = localStorage.getItem('email') || '';
  const savedPic = localStorage.getItem('profilePic') || '';

  if (savedName) fullnameInput.value = savedName;
  if (savedEmail) emailInput.value = savedEmail;
  if (savedPic) {
    byId('profilePicPreview').src = savedPic;
    byId('sidebarProfilePic').src = savedPic;
  }

  // ===================== Profile picture upload =====================
  byId('uploadProfile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const imgData = event.target.result;
      byId('profilePicPreview').src = imgData;
      byId('sidebarProfilePic').src = imgData;
      localStorage.setItem('profilePic', imgData);
    };
    reader.readAsDataURL(file);
  });

  // ===================== Save changes =====================
  byId('saveBtn').addEventListener('click', () => {
    const fullname = fullnameInput.value.trim();
    const email = emailInput.value.trim();

    if (!fullname) { alert('Full name is required!'); return; }
    if (!email) { alert('Email is required!'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('Please enter a valid email address!'); return; }

    localStorage.setItem('fullname', fullname);
    localStorage.setItem('email', email);
    localStorage.setItem('emailVerified', 'false'); // reset verification

    alert('Profile updated successfully! ✅ Please verify your email');
    window.location.href = '/folder/myprofile';
  });

  // ===================== Logout =====================
  byId('logoutBtn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = '/onboarding?tab=login';
  });
});
