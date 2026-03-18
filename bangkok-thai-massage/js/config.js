// Bangkok Thai Massage — Frontend Config
// Edit BACKEND_URL and STRIPE_PUBLIC_KEY before deploying.

window.BACKEND_URL = (function () {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  // Production: your Node.js API server
  // If backend is on the same server: return '' (empty = same origin)
  // If backend is on a subdomain: return 'https://api.bangkokthaimassage.pt'
  return 'https://api.bangkokthaimassage.pt';
}());

// Stripe publishable key — safe to expose in frontend
window.STRIPE_PUBLIC_KEY = 'pk_live_REPLACE_WITH_YOUR_STRIPE_PUBLIC_KEY';
