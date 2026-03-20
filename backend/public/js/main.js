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

// ── INSTAGRAM FEED ──
async function loadInstagramFeed() {
  const grid = document.getElementById('igGrid');
  if (!grid) return;

  try {
    const base = (typeof window.BACKEND_URL !== 'undefined') ? window.BACKEND_URL : '';
    const res = await fetch(base + '/api/instagram-feed');
    if (!res.ok) return;
    const { posts } = await res.json();
    if (!posts || posts.length === 0) return;

    const igIconSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0z"/></svg>`;

    grid.innerHTML = posts.map(p => `
      <a class="instagram-post" href="${p.permalink}" target="_blank" rel="noopener">
        <img src="${p.url}" alt="Bangkok Thai Massage" loading="lazy">
        <div class="instagram-post__overlay">${igIconSvg}</div>
      </a>`).join('');

    // Re-observe new elements for reveal animation
    grid.querySelectorAll('.instagram-post').forEach(el => {
      el.classList.add('reveal');
      revealObserver.observe(el);
    });
  } catch (e) {
    // silently keep placeholders on error
  }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  applyLang();
  loadInstagramFeed();
});
