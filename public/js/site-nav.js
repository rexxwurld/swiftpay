// Shared marketing-site behaviour — vanilla JS, no jQuery.
// Covers: mobile hamburger menu, dynamic footer year, and the
// scroll-in fade animation used on the pricing/products/policy cards.
document.addEventListener('DOMContentLoaded', function () {
  var menuIcon = document.getElementById('menuIcon');
  var navLinks = document.getElementById('navLinks');

  // ---- Hamburger menu toggle ----
  if (menuIcon && navLinks) {
    menuIcon.addEventListener('click', function () {
      menuIcon.classList.toggle('active');
      navLinks.classList.toggle('active');
    });

    // Close menu when a nav link is clicked (mobile only)
    navLinks.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        var menuIconVisible = menuIcon.offsetParent !== null;
        if (menuIconVisible) {
          navLinks.classList.remove('active');
          menuIcon.classList.remove('active');
        }
      });
    });

    // Close mobile menu on outside click
    document.addEventListener('click', function (event) {
      var clickedInside = navLinks.contains(event.target) || menuIcon.contains(event.target);
      if (!clickedInside && navLinks.classList.contains('active')) {
        navLinks.classList.remove('active');
        menuIcon.classList.remove('active');
      }
    });
  }

  // ---- Scroll-in fade animation for cards ----
  var cards = document.querySelectorAll('.policy-card, .pricing-card, .product-card');
  if (cards.length) {
    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('fade-in');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15 });
      cards.forEach(function (card) { observer.observe(card); });
    } else {
      // Fallback for very old browsers without IntersectionObserver
      cards.forEach(function (card) { card.classList.add('fade-in'); });
    }
  }

  // ---- Pricing plan selection (pricing.html only) ----
  document.querySelectorAll('.pricing-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var plan = btn.getAttribute('data-plan');
      if (plan) localStorage.setItem('selectedPlan', plan);
    });
  });

  // ---- Dynamic footer year ----
  var footerYearSpan = document.querySelector('.footer-bottom span');
  if (footerYearSpan) {
    footerYearSpan.textContent = '©️ ' + new Date().getFullYear() + ' SwiftPay. All rights reserved.';
  }
});
