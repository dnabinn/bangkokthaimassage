import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import mysql from 'mysql2/promise';
import twilio from 'twilio';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Serve frontend static files
app.use(express.static(join(__dirname, '../bangkok-thai-massage')));

// ── CLIENTS ──
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const dbConfig = {
  user:             process.env.DB_USER,
  password:         process.env.DB_PASSWORD,
  database:         process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:  10,
  charset:          'utf8mb4'
};
// Use Unix socket if DB_SOCKET is set (avoids TCP permission issues on shared hosts)
if (process.env.DB_SOCKET) {
  dbConfig.socketPath = process.env.DB_SOCKET;
} else {
  dbConfig.host = process.env.DB_HOST || '127.0.0.1';
}
const db = mysql.createPool(dbConfig);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const mailer = nodemailer.createTransport({
  host: 'smtp.hostinger.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,     // e.g. geral@bangkokthaimassage.pt
    pass: process.env.EMAIL_PASSWORD
  }
});

const LOC_ADDR = {
  saldanha: 'R. Gomes Freire 223C, 1150-178 Lisboa',
  caparica: 'R. dos Pescadores 5, 2825-280 Costa da Caparica'
};

// ── HEALTH CHECK ──
app.get('/api/health', async (_req, res) => {
  try {
    await db.execute('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (e) {
    res.status(500).json({ ok: false, db: e.message });
  }
});

// ── GET /api/slots ──
// Returns taken time slots for a given location + date
app.get('/api/slots', async (req, res) => {
  const { location, date } = req.query;
  if (!location || !date) {
    return res.status(400).json({ error: 'location and date are required' });
  }
  try {
    const [rows] = await db.execute(
      'SELECT time FROM blocked_slots WHERE location = ? AND date = ?',
      [location, date]
    );
    res.json({ taken: rows.map(r => r.time) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/create-payment-intent ──
app.post('/api/create-payment-intent', async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount is required' });
  }
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // euros → cents
      currency: 'eur',
      automatic_payment_methods: { enabled: true }
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mbway-charge ──
app.post('/api/mbway-charge', async (req, res) => {
  const { phone, amount, bookingRef } = req.body;
  if (!phone || !amount) {
    return res.status(400).json({ error: 'phone and amount are required' });
  }
  try {
    const response = await fetch('https://api.sibspayments.com/sibs/pos/v1/payments/mbway', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MBWAY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: { value: amount, currency: 'EUR' },
        merchantTransactionId: bookingRef || ('BTM-' + Date.now()),
        customerPhone: phone.replace(/\s/g, ''),
        merchantId: process.env.MBWAY_MERCHANT_ID
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/book ──
app.post('/api/book', async (req, res) => {
  const {
    location, service, duration, price,
    date, time, name, email, phone, notes,
    paymentIntentId, payMethod
  } = req.body;

  const required = { location, service, duration, price, date, time, name, email, phone };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }

  const ref    = 'BTM-' + Math.floor(100000 + Math.random() * 900000);
  const status = payMethod === 'whatsapp' ? 'pending' : 'confirmed';

  try {
    // 1. Save booking
    await db.execute(
      `INSERT INTO bookings
        (ref, location, service, duration, price, date, time, name, email, phone, notes, payment_intent_id, pay_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ref, location, service, duration, price, date, time, name, email, phone,
       notes || null, paymentIntentId || null, payMethod || 'unknown', status]
    );

    // 2. Block the slot (INSERT IGNORE skips if already taken)
    await db.execute(
      'INSERT IGNORE INTO blocked_slots (location, date, time) VALUES (?, ?, ?)',
      [location, date, time]
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // 3. Twilio SMS (non-blocking — booking is already saved)
  try {
    const toPhone = phone.startsWith('+') ? phone : '+351' + phone.replace(/\s/g, '');
    await twilioClient.messages.create({
      body: `Bangkok Thai Massage\nReserva: ${ref}\n${service} – ${duration}min\n${date} às ${time}\n${LOC_ADDR[location]}\nObrigado, ${name.split(' ')[0]}!`,
      from: process.env.TWILIO_FROM_NUMBER,
      to: toPhone
    });
    const staffPhone = location === 'saldanha'
      ? process.env.STAFF_PHONE_SALDANHA
      : process.env.STAFF_PHONE_CAPARICA;
    if (staffPhone) {
      await twilioClient.messages.create({
        body: `[BTM] Nova reserva!\nRef: ${ref}\n${name} | ${phone}\n${service} – ${duration}min\n${date} às ${time}\nLocal: ${location}`,
        from: process.env.TWILIO_FROM_NUMBER,
        to: staffPhone
      });
    }
  } catch (smsErr) {
    console.error('Twilio error:', smsErr.message);
  }

  // 4. Email via Hostinger SMTP (non-blocking)
  try {
    await mailer.sendMail({
      from: `"Bangkok Thai Massage" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Reserva confirmada — ${ref} | Bangkok Thai Massage`,
      html: buildEmailHtml({ ref, name, location, service, duration, date, time, price })
    });
  } catch (emailErr) {
    console.error('Email error:', emailErr.message);
  }

  res.json({ success: true, ref });
});

// ── EMAIL TEMPLATE ──
function buildEmailHtml({ ref, name, location, service, duration, date, time, price }) {
  const firstName = name.split(' ')[0];
  const addr = LOC_ADDR[location];
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAF7EF;font-family:'Georgia',serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #E8E0D0;border-radius:8px;overflow:hidden;">
    <div style="background:#0D2818;padding:32px 40px;">
      <p style="margin:0;color:#C9A84C;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;">Bangkok Thai Massage</p>
      <h1 style="margin:8px 0 0;color:#FAF7EF;font-weight:400;font-size:26px;">Reserva Confirmada</h1>
    </div>
    <div style="padding:32px 40px;">
      <p style="color:#444;font-size:15px;line-height:1.7;">Olá ${firstName},</p>
      <p style="color:#444;font-size:15px;line-height:1.7;">A sua sessão foi reservada com sucesso. Até breve!</p>
      <div style="background:#FAF7EF;border:1px solid #E8E0D0;border-radius:6px;padding:20px 24px;margin:24px 0;">
        <p style="margin:0 0 4px;font-size:10px;color:#999;letter-spacing:0.15em;text-transform:uppercase;">Referência</p>
        <p style="margin:0 0 16px;font-size:18px;color:#0D2818;font-weight:600;letter-spacing:0.08em;">${ref}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#888;width:40%">Local</td><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#222;">${addr}</td></tr>
          <tr><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#888;">Serviço</td><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#222;">${service} — ${duration} min</td></tr>
          <tr><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#888;">Data</td><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#222;">${date}</td></tr>
          <tr><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#888;">Hora</td><td style="padding:6px 0;border-bottom:1px solid #E8E0D0;color:#222;">${time}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Total</td><td style="padding:6px 0;color:#1E4728;font-weight:600;">€${price}</td></tr>
        </table>
      </div>
      <p style="color:#666;font-size:13px;line-height:1.7;">⏰ Por favor chegue 5 minutos antes da sua sessão.<br>📍 ${addr}</p>
    </div>
    <div style="background:#FAF7EF;padding:20px 40px;border-top:1px solid #E8E0D0;">
      <p style="margin:0;font-size:12px;color:#999;">© Bangkok Thai Massage · info@bangkokthaimassage.pt</p>
    </div>
  </div>
</body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BTM API running on port ${PORT}`));
