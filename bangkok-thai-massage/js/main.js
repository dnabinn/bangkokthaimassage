/* Bangkok Thai Massage — Main JS */

// ── LANGUAGE ──
let currentLang = localStorage.getItem('btm-lang') || 'pt';

function toggleLang() {
  currentLang = currentLang === 'pt' ? 'en' : 'pt';
  localStorage.setItem('btm-lang', currentLang);
  applyLang();
}

function applyLang() {
  const toggle = document.getElementById('langToggle');
  if (toggle) toggle.textContent = currentLang === 'pt' ? 'EN' : 'PT';
  document.querySelectorAll('[data-pt]').forEach(el => {
    const val = el.getAttribute('data-' + currentLang);
    if (!val) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = val;
    } else if (val.includes('<br>')) {
      el.innerHTML = val;
    } else {
      el.textContent = val;
    }
  });
  document.documentElement.lang = currentLang;
}

// ── NAV SCROLL ──
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  if (nav) nav.classList.toggle('scrolled', window.scrollY > 60);
}, { passive: true });

// ── MOBILE MENU ──
function toggleMenu() {
  const links = document.getElementById('navLinks');
  const burger = document.getElementById('burger');
  if (!links) return;
  const open = links.classList.toggle('open');
  burger.style.opacity = open ? '0.7' : '1';
  document.body.style.overflow = open ? 'hidden' : '';
}

// ── REVEAL ON SCROLL ──
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      revealObserver.unobserve(e.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  applyLang();
});
