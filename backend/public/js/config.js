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
  return ''; // same origin — backend serves frontend from same domain
}());

// Stripe publishable key — safe to expose in frontend
window.STRIPE_PUBLIC_KEY = 'pk_live_51T5B3LH1eDQy4U2F1GcykziFB58lEt1fcxBkDy4ri8WhqXqqPzzsqYtiHilqm4N8DN8iGdsLqRYTSdyEu80Blkki00LBWsDbI1';
