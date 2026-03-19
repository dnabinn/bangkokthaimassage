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
// Raw body needed for Stripe webhook signature verification (must be before express.json)
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Serve frontend static files
app.use(express.static(join(__dirname, 'public')));

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
  const { amount, paymentMethod } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount is required' });
  }
  try {
    const params = {
      amount: Math.round(amount * 100), // euros → cents
      currency: 'eur',
    };
    if (paymentMethod === 'mb_way') {
      params.payment_method_types = ['mb_way'];
    } else {
      params.automatic_payment_methods = { enabled: true };
    }
    const paymentIntent = await stripe.paymentIntents.create(params);
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mbway-charge ──
// Creates AND confirms a MB WAY PaymentIntent server-side.
// Stripe sends the push notification to the customer's MB WAY app directly.
app.post('/api/mbway-charge', async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) {
    return res.status(400).json({ error: 'phone and amount are required' });
  }
  try {
    const toPhone = phone.startsWith('+') ? phone : '+351' + phone.replace(/\s/g, '');
    // Create PaymentIntent for MB WAY
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'eur',
      payment_method_types: ['mb_way'],
    });
    // Confirm server-side with phone — Stripe sends push to MB WAY app
    const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, {
      payment_method_data: {
        type: 'mb_way',
        billing_details: { phone: toPhone },
      },
    });
    res.json({ paymentIntentId: confirmed.id, status: confirmed.status });
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
  // mbway: pending until customer approves in MB WAY app (webhook confirms it)
  const status = (payMethod === 'whatsapp' || payMethod === 'mbway') ? 'pending' : 'confirmed';

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

  // 3 & 4. SMS + Email — only for confirmed payments (not MB WAY pending)
  if (payMethod !== 'mbway') {
    await sendConfirmations({ ref, name, phone, email, location, service, duration, date, time, price });
  }

  res.json({ success: true, ref });
});

// ── SHARED: SMS + EMAIL CONFIRMATIONS ──
async function sendConfirmations({ ref, name, phone, email, location, service, duration, date, time, price }) {
  const toPhone = String(phone).startsWith('+') ? phone : '+351' + String(phone).replace(/\s/g, '');
  // SMS to customer
  try {
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
    console.error('Twilio SMS error:', smsErr.message);
  }
  // Email to customer
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
}

// ── STRIPE WEBHOOK ──
// Confirms MB WAY bookings when customer approves payment in the app
app.post('/api/stripe-webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body); // no secret set — skip verification (dev only)
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    try {
      const [rows] = await db.execute(
        "SELECT * FROM bookings WHERE payment_intent_id = ? AND status = 'pending' LIMIT 1",
        [pi.id]
      );
      if (rows.length) {
        const b = rows[0];
        await db.execute(
          "UPDATE bookings SET status = 'confirmed' WHERE payment_intent_id = ?",
          [pi.id]
        );
        // Now payment is confirmed — send SMS + email
        await sendConfirmations(b);
      }
    } catch (err) {
      console.error('Webhook error:', err.message);
    }
  }

  res.json({ received: true });
});

// ── ADMIN MIDDLEWARE ──
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── GET /api/admin/bookings ──
app.get('/api/admin/bookings', adminAuth, async (req, res) => {
  const { location, status, from, to } = req.query;
  let sql = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];
  if (location) { sql += ' AND location = ?'; params.push(location); }
  if (status)   { sql += ' AND status = ?';   params.push(status); }
  if (from)     { sql += ' AND date >= ?';    params.push(from); }
  if (to)       { sql += ' AND date <= ?';    params.push(to); }
  sql += ' ORDER BY date DESC, time DESC';
  try {
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/stats ──
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [[totals]] = await db.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='confirmed' THEN price ELSE 0 END) AS revenue,
        SUM(CASE WHEN location='saldanha'  AND status='confirmed' THEN 1 ELSE 0 END) AS saldanha,
        SUM(CASE WHEN location='caparica'  AND status='confirmed' THEN 1 ELSE 0 END) AS caparica,
        SUM(CASE WHEN date = CURDATE() THEN 1 ELSE 0 END) AS today
      FROM bookings
    `);
    res.json(totals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/bookings/:ref ──
app.patch('/api/admin/bookings/:ref', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'pending', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    await db.execute('UPDATE bookings SET status = ? WHERE ref = ?', [status, req.params.ref]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
