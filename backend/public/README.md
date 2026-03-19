# Bangkok Thai Massage — Website

## Project Structure
```
/
├── index.html              ← Homepage
├── css/main.css            ← Shared stylesheet
├── js/main.js              ← Shared JS (lang toggle, nav, scroll reveal)
└── pages/
    ├── localizacoes.html   ← Locations + full services/prices per location
    ├── reservar.html       ← 5-step booking flow (UI complete, backend needed)
    ├── sobre.html          ← About page (placeholder)
    └── contacto.html       ← Contact page (placeholder)
```

## Design System
- Colors: --green-deep #0D2818, --gold #C9A84C, --cream #FAF7EF
- Fonts: Cormorant Garamond (display) + Jost (body)
- Bilingual: PT/EN toggle via data-pt / data-en attributes on every element
- Lang preference stored in localStorage as 'btm-lang'

## Locations
| Location | Address | Phone | Hours |
|---|---|---|---|
| Saldanha | R. Gomes Freire 223C, 1150-178 Lisboa | 925 693 355 | Mon–Sun 10–21h |
| Costa da Caparica | R. dos Pescadores 5, 2825-280 | 932 141 557 | Mon–Sat 10–21h, Sun 11–21h |

## Services
- Saldanha: 12 services
- Costa da Caparica: 14 services (+ Esfoliação + Grávidas)
- All prices include VAT

## BACKEND NEEDED (Claude Code phase)

### 1. Stripe Payments
- File: pages/reservar.html — Step 5 card fields
- Replace card fields with Stripe.js Elements
- Add backend endpoint: POST /api/create-payment-intent
- Keys needed: STRIPE_PUBLIC_KEY, STRIPE_SECRET_KEY

### 2. MB WAY
- Add backend endpoint: POST /api/mbway-charge
- Provider: SIBS (Portuguese payment processor)
- Keys needed: MBWAY_API_KEY

### 3. Booking Database (Supabase)
- Table: bookings (id, location, service, duration, price, date, time, name, email, phone, notes, status, ref, created_at)
- Table: blocked_slots (location, date, time) — to mark taken slots
- The calendar's TAKEN array in reservar.html must be replaced with a real API call

### 4. Twilio SMS
- Trigger: on booking confirmed
- SMS to customer: booking ref + date + address
- SMS to staff: new booking alert
- Keys needed: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

### 5. Email Confirmation (SendGrid or Resend)
- Trigger: on booking confirmed
- Email to customer: booking summary + ref
- Keys needed: SENDGRID_API_KEY or RESEND_API_KEY

### 6. Deploy: GitHub → Hostinger
- Static files: index.html, css/, js/, pages/
- Backend: Node.js serverless functions OR separate Express server
- Domain: bangkokthaimassage.pt
- Subdomains to redirect: saldanha.bangkokthaimassage.pt, costadacaparica.bangkokthaimassage.pt

## Contact
- Email: geral@bangkokthaimassage.pt
- WhatsApp Saldanha: +351 925 693 355
- WhatsApp Caparica: +351 932 141 557
- Facebook: facebook.com/bangkokthaimassage.pt
- Instagram: instagram.com/bangkokthaimassage.pt
