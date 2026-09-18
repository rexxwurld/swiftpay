function init() {

  // ===== HAMBURGER MENU TOGGLE =====
  var menuIcon = document.getElementById('menuIcon');
  var navLinks = document.getElementById('navLinks');

  menuIcon.addEventListener('click', function () {
    menuIcon.classList.toggle('active');
    navLinks.classList.toggle('active');
  });

  // ===== CLOSE MENU ON MOBILE WHEN LINK CLICKED =====
  var navLinkItems = navLinks.querySelectorAll('a');
  navLinkItems.forEach(function(link) {
    link.addEventListener('click', function () {
      if (getComputedStyle(menuIcon).display !== 'none') {
        navLinks.classList.remove('active');
        menuIcon.classList.remove('active');
      }
    });
  });

  // ===== CLOSE MENU IF CLICK OUTSIDE =====
  document.addEventListener('click', function (event) {
    if (!event.target.closest('#navLinks, #menuIcon')) {
      if (navLinks.classList.contains('active')) {
        navLinks.classList.remove('active');
        menuIcon.classList.remove('active');
      }
    }
  });

  // ===== SMOOTH SCROLL FOR ANCHOR LINKS =====
  document.querySelectorAll('a[href^="#"]').forEach(function(anchor) {
    anchor.addEventListener('click', function(e) {
      e.preventDefault();
      var target = this.getAttribute('href');
      if (target !== "#" && document.querySelector(target)) {
        var targetEl = document.querySelector(target);
        var targetPosition = targetEl.getBoundingClientRect().top + window.pageYOffset - 60;
        window.scrollTo({ top: targetPosition, behavior: 'smooth' });
      }
    });
  });

  // ===== DEVELOPER SECTION CODE SAMPLES =====
  var codeSamples = {
    CURL: 'curl -X POST https://api.example.com',
    Node: 'const api = require("api");\napi.sendPayment();',
    Dotnet: 'var api = new ApiClient();\napi.SendPayment();',
    Python: 'import api\napi.send_payment()'
  };

  var codeContent = document.querySelector('.code-content');
  var langButtons = document.querySelectorAll('.bodychild1in1 button');

  codeContent.textContent = codeSamples.CURL;
  langButtons.forEach(function(btn) { btn.classList.remove('active-btn'); });
  document.querySelector('.bodychild1in1 button[data-lang="CURL"]').classList.add('active-btn');

  langButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var lang = this.getAttribute('data-lang');
      var code = codeSamples[lang];
      codeContent.textContent = code;
      langButtons.forEach(function(b) { b.classList.remove('active-btn'); });
      this.classList.add('active-btn');
    });
  });

  // ===== COPY BUTTON =====
  var copyBtn = document.querySelector('.copy-btn');
  copyBtn.addEventListener('click', function() {
    var code = codeContent.textContent.trim();
    if (!code) return;
    navigator.clipboard.writeText(code).then(function() {
      copyBtn.textContent = 'Copied ✓';
      setTimeout(function(){ copyBtn.textContent = 'Copy'; }, 1500);
    });
  });

  // ===== CONTACT FORM RESET AND SUCCESS MESSAGE =====
  var contactBtn = document.querySelector('.body7only2 button');
  contactBtn.addEventListener('click', function() {
    var form = this.closest('form');
    form.reset();
    var msgDiv = form.querySelector('.form-message');
    msgDiv.textContent = "Request submitted successfully ✅";
    msgDiv.style.display = "block";
    setTimeout(function() { msgDiv.style.display = "none"; }, 3000);
  });

  // ===== PRICING BUTTON CLICK =====
  document.querySelectorAll('.pricing-btn').forEach(function(btn) {
    btn.addEventListener('click', function () {
      var plan = this.getAttribute('data-plan');
      localStorage.setItem('selectedPlan', plan);
    });
  });

  // ===== UPDATE FOOTER YEAR DYNAMICALLY =====
  document.querySelector('.footer-bottom span').textContent =
    '©️ ' + new Date().getFullYear() + ' SwiftPay. All rights reserved.';

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
