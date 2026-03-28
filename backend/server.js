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
// Returns taken time slots based on STAFF AVAILABILITY, not blocked_slots table.
// A slot is "taken" when fewer than groupSize therapists are free for the full duration.
app.get('/api/slots', async (req, res) => {
  const { location, date, duration, groupSize } = req.query;
  if (!location || !date) {
    return res.status(400).json({ error: 'location and date are required' });
  }
  const ALL_SLOTS = ['10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30',
    '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30',
    '18:00','18:30','19:00','19:30','20:00','20:30'];
  const needed = Math.max(1, parseInt(groupSize) || 1);
  const dur    = Math.max(30, parseInt(duration) || 60);

  function toMins(t) { const [h,m] = t.split(':').map(Number); return h*60+m; }

  try {
    const dayOfWeek = new Date(date + 'T12:00:00').getDay();
    const [staffRows] = await db.execute(
      `SELECT s.id FROM staff s
       JOIN staff_schedule ss ON ss.staff_id = s.id
       WHERE s.location = ? AND s.active = 1 AND ss.day_of_week = ?`,
      [location, dayOfWeek]
    );
    // If not enough staff at all, mark everything taken
    if (staffRows.length < needed) {
      return res.json({ taken: ALL_SLOTS });
    }
    const [bookings] = await db.execute(
      `SELECT staff_id, time, duration FROM bookings
       WHERE location = ? AND date = ? AND status != 'cancelled'`,
      [location, date]
    );
    const taken = [];
    for (const slot of ALL_SLOTS) {
      const slotStart = toMins(slot);
      const slotEnd   = slotStart + dur + 15;

      const overlaps = b => {
        const bStart = toMins(b.time);
        const bEnd   = bStart + parseInt(b.duration) + 15;
        return slotStart < bEnd && slotEnd > bStart;
      };

      // Count assigned-staff conflicts per therapist
      let freeCount = 0;
      for (const s of staffRows) {
        const busy = bookings
          .filter(b => b.staff_id != null && Number(b.staff_id) === Number(s.id))
          .some(overlaps);
        if (!busy) freeCount++;
      }

      // Unassigned bookings (staff_id IS NULL) still occupy one therapist slot each
      const unassigned = bookings.filter(b => b.staff_id == null && overlaps(b)).length;
      freeCount = Math.max(0, freeCount - unassigned);

      if (freeCount < needed) taken.push(slot);
    }
    res.json({ taken });
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

// ── GET /api/staff ──
// Public endpoint — returns staff for a location+date with availability
app.get('/api/staff', async (req, res) => {
  const { location, date, time, duration } = req.query;
  if (!location || !date) {
    return res.status(400).json({ error: 'location and date are required' });
  }
  try {
    const dayOfWeek = new Date(date + 'T12:00:00').getDay();
    const [staffRows] = await db.execute(
      `SELECT s.id, s.name FROM staff s
       JOIN staff_schedule ss ON ss.staff_id = s.id
       WHERE s.location = ? AND s.active = 1 AND ss.day_of_week = ?
       ORDER BY s.id`,
      [location, dayOfWeek]
    );

    if (!time || !duration) {
      return res.json(staffRows.map(s => ({ id: s.id, name: s.name, available: true })));
    }

    const [hh, mm] = time.split(':').map(Number);
    const newStart = hh * 60 + mm;
    const newEnd   = newStart + parseInt(duration) + 15;

    const overlapsWindow = b => {
      const [bh, bm] = b.time.split(':').map(Number);
      const bStart = bh * 60 + bm;
      const bEnd   = bStart + parseInt(b.duration) + 15;
      return newStart < bEnd && newEnd > bStart;
    };

    // Fetch ALL bookings for this location+date (assigned and unassigned)
    const [allBookings] = await db.execute(
      `SELECT staff_id, time, duration FROM bookings
       WHERE location = ? AND date = ? AND status != 'cancelled'`,
      [location, date]
    );

    const result = staffRows.map(s => {
      const busy = allBookings
        .filter(b => b.staff_id != null && Number(b.staff_id) === Number(s.id))
        .some(overlapsWindow);
      return { id: s.id, name: s.name, available: !busy };
    });

    // Unassigned bookings still occupy one therapist — mark the first N free therapists as busy
    const unassignedConflicts = allBookings.filter(b => b.staff_id == null && overlapsWindow(b)).length;
    let toMark = unassignedConflicts;
    for (const r of result) {
      if (toMark <= 0) break;
      if (r.available) { r.available = false; toMark--; }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/book ──
app.post('/api/book', async (req, res) => {
  const {
    location, service, duration, price,
    date, time, name, email, phone, notes,
    paymentIntentId, payMethod, staffId
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
        (ref, location, staff_id, service, duration, price, date, time, name, email, phone, notes, payment_intent_id, pay_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ref, location, staffId || null, service, duration, price, date, time, name, email, phone,
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
  } catch (smsErr) {
    console.error('Twilio SMS (customer) error:', smsErr.message);
  }
  // SMS to owner/staff
  try {
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
    console.error('Twilio SMS (owner) error:', smsErr.message);
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

// ── GET /api/admin/staff ──
app.get('/api/admin/staff', adminAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT s.id, s.name, s.location, s.active,
              GROUP_CONCAT(ss.day_of_week ORDER BY ss.day_of_week) AS schedule_days
       FROM staff s
       LEFT JOIN staff_schedule ss ON ss.staff_id = s.id
       GROUP BY s.id
       ORDER BY s.location, s.id`
    );
    const staff = rows.map(r => ({
      id: r.id,
      name: r.name,
      location: r.location,
      active: !!r.active,
      schedule: r.schedule_days ? r.schedule_days.split(',').map(Number) : []
    }));
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/staff ──
app.post('/api/admin/staff', adminAuth, async (req, res) => {
  const { name, location, schedule } = req.body;
  if (!name || !location) return res.status(400).json({ error: 'name and location are required' });
  try {
    const [result] = await db.execute(
      'INSERT INTO staff (name, location) VALUES (?, ?)',
      [name, location]
    );
    const staffId = result.insertId;
    if (schedule && schedule.length) {
      for (const day of schedule) {
        await db.execute(
          'INSERT IGNORE INTO staff_schedule (staff_id, day_of_week) VALUES (?, ?)',
          [staffId, day]
        );
      }
    }
    res.json({ success: true, id: staffId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/staff/:id ──
app.patch('/api/admin/staff/:id', adminAuth, async (req, res) => {
  const { name, active, schedule } = req.body;
  const id = req.params.id;
  try {
    if (name !== undefined) {
      await db.execute('UPDATE staff SET name = ? WHERE id = ?', [name, id]);
    }
    if (active !== undefined) {
      await db.execute('UPDATE staff SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    }
    if (schedule !== undefined) {
      await db.execute('DELETE FROM staff_schedule WHERE staff_id = ?', [id]);
      for (const day of schedule) {
        await db.execute(
          'INSERT IGNORE INTO staff_schedule (staff_id, day_of_week) VALUES (?, ?)',
          [id, day]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/bookings (manual / walk-in / phone) ──
app.post('/api/admin/bookings', adminAuth, async (req, res) => {
  const { location, service, duration, price, date, time, name, email, phone, notes, pay_method, staffId, status, groupSize } = req.body;
  const required = { location, service, duration, price, date, time, name, email, phone };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });

  const bookingStatus = status || 'confirmed';
  const needed        = Math.max(1, parseInt(groupSize) || 1);

  function toMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

  // Get available staff for auto-assignment
  const dayOfWeek = new Date(date + 'T12:00:00').getDay();
  const [staffRows] = await db.execute(
    `SELECT s.id FROM staff s
     JOIN staff_schedule ss ON ss.staff_id = s.id
     WHERE s.location = ? AND s.active = 1 AND ss.day_of_week = ?`,
    [location, dayOfWeek]
  );
  const [existingBookings] = await db.execute(
    `SELECT staff_id, time, duration FROM bookings
     WHERE location = ? AND date = ? AND status != 'cancelled' AND staff_id IS NOT NULL`,
    [location, date]
  );

  const slotStart = toMins(time);
  const slotEnd   = slotStart + parseInt(duration) + 15;

  function isBusy(sId) {
    return existingBookings.some(b => {
      if (Number(b.staff_id) !== Number(sId)) return false;
      const bStart = toMins(b.time);
      const bEnd   = bStart + parseInt(b.duration) + 15;
      return slotStart < bEnd && slotEnd > bStart;
    });
  }

  // Build staff assignments: use specified staffId first, then auto-assign free ones
  const assignments = [];
  const usedIds = new Set();
  if (staffId) { assignments.push(parseInt(staffId)); usedIds.add(parseInt(staffId)); }
  for (const s of staffRows) {
    if (assignments.length >= needed) break;
    if (!usedIds.has(Number(s.id)) && !isBusy(s.id)) {
      assignments.push(Number(s.id));
      usedIds.add(Number(s.id));
      existingBookings.push({ staff_id: s.id, time, duration }); // mark busy for next iteration
    }
  }
  while (assignments.length < needed) assignments.push(null);

  const refs = [];
  try {
    for (let i = 0; i < needed; i++) {
      const r = 'BTM-' + Math.floor(100000 + Math.random() * 900000);
      refs.push(r);
      await db.execute(
        `INSERT INTO bookings
          (ref, location, staff_id, group_size, service, duration, price, date, time, name, email, phone, notes, pay_method, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r, location, assignments[i], needed, service, duration, price, date, time, name, email, phone,
         notes || null, pay_method || 'cash', bookingStatus]
      );
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (bookingStatus === 'confirmed') {
    await sendConfirmations({ ref: refs[0], name, phone, email, location, service, duration, date, time, price });
  }

  res.json({ success: true, ref: refs[0], refs });
});

// ── GET /api/admin/schedule ──
app.get('/api/admin/schedule', adminAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required' });
  try {
    const dayOfWeek = new Date(date + 'T12:00:00').getDay();
    const [staff] = await db.execute(
      `SELECT s.id, s.name, s.location
       FROM staff s
       JOIN staff_schedule ss ON ss.staff_id = s.id
       WHERE s.active = 1 AND ss.day_of_week = ?
       ORDER BY s.location, s.id`,
      [dayOfWeek]
    );
    const [bookings] = await db.execute(
      `SELECT ref, staff_id, service, duration, time, name, status, location
       FROM bookings
       WHERE date = ? AND status != 'cancelled' AND staff_id IS NOT NULL`,
      [date]
    );
    res.json({ staff, bookings });
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
    // Auto-assign a random free therapist when confirming an unassigned booking
    if (status === 'confirmed') {
      const [[booking]] = await db.execute(
        'SELECT location, date, time, duration, staff_id FROM bookings WHERE ref = ?',
        [req.params.ref]
      );
      if (booking && !booking.staff_id) {
        const dayOfWeek = new Date(booking.date + 'T12:00:00').getDay();
        const [staffRows] = await db.execute(
          `SELECT s.id FROM staff s
           JOIN staff_schedule ss ON ss.staff_id = s.id
           WHERE s.location = ? AND s.active = 1 AND ss.day_of_week = ?`,
          [booking.location, dayOfWeek]
        );
        const [conflicts] = await db.execute(
          `SELECT staff_id, time, duration FROM bookings
           WHERE location = ? AND date = ? AND status != 'cancelled'
             AND staff_id IS NOT NULL AND ref != ?`,
          [booking.location, booking.date, req.params.ref]
        );
        function toMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
        const bStart = toMins(booking.time);
        const bEnd   = bStart + parseInt(booking.duration) + 15;
        const busyIds = new Set(
          conflicts
            .filter(c => {
              const cStart = toMins(c.time);
              const cEnd   = cStart + parseInt(c.duration) + 15;
              return bStart < cEnd && bEnd > cStart;
            })
            .map(c => Number(c.staff_id))
        );
        const freeStaff = staffRows.filter(s => !busyIds.has(Number(s.id)));
        if (freeStaff.length > 0) {
          const assigned = freeStaff[Math.floor(Math.random() * freeStaff.length)];
          await db.execute('UPDATE bookings SET status = ?, staff_id = ? WHERE ref = ?', [status, assigned.id, req.params.ref]);
          return res.json({ success: true, staff_id: assigned.id });
        }
      }
    }
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

// ── GET /api/instagram-feed ──
// Fetches latest 6 posts from Instagram Business Account, cached for 1 hour
let igCache = { posts: [], fetchedAt: 0 };

app.get('/api/instagram-feed', async (_req, res) => {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return res.json({ posts: [] });

  // Return cache if fresh (< 1 hour)
  if (igCache.posts.length && Date.now() - igCache.fetchedAt < 3600000) {
    return res.json({ posts: igCache.posts });
  }

  try {
    // Step 1: Get Facebook Page with IG Business Account attached
    const pagesResp = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?fields=instagram_business_account&access_token=${token}`
    );
    const pagesData = await pagesResp.json();
    const page = (pagesData.data || []).find(p => p.instagram_business_account);
    if (!page) return res.json({ posts: [] });

    const igId = page.instagram_business_account.id;

    // Step 2: Fetch recent media
    const mediaResp = await fetch(
      `https://graph.facebook.com/v19.0/${igId}/media?fields=id,media_type,media_url,permalink,thumbnail_url&limit=9&access_token=${token}`
    );
    const mediaData = await mediaResp.json();

    const posts = (mediaData.data || [])
      .filter(p => p.media_type === 'IMAGE' || p.media_type === 'CAROUSEL_ALBUM')
      .slice(0, 6)
      .map(p => ({
        id: p.id,
        url: p.media_url || p.thumbnail_url,
        permalink: p.permalink
      }));

    igCache = { posts, fetchedAt: Date.now() };
    res.json({ posts });
  } catch (err) {
    console.error('Instagram feed error:', err.message);
    res.json({ posts: igCache.posts }); // return stale cache on error
  }
});

// ── POST /api/contact ──
app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Missing fields' });
  try {
    await mailer.sendMail({
      from: `"Bangkok Thai Massage" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      replyTo: email,
      subject: `Contacto: ${subject || 'Nova mensagem'} — ${name}`,
      html: `<p><strong>De:</strong> ${name} (${email})</p><p><strong>Assunto:</strong> ${subject || '—'}</p><p><strong>Mensagem:</strong><br>${message.replace(/\n/g, '<br>')}</p>`
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact email error:', err.message);
    res.status(500).json({ error: 'Failed to send' });
  }
});

// ── MIGRATE ──
async function migrate() {
  // 1. Create staff table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS staff (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      location VARCHAR(50) NOT NULL,
      active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Create staff_schedule table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS staff_schedule (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      day_of_week TINYINT NOT NULL,
      UNIQUE KEY uq_staff_day (staff_id, day_of_week)
    )
  `);

  // 3. Add staff_id column to bookings if it doesn't exist
  try {
    await db.execute('ALTER TABLE bookings ADD COLUMN staff_id INT NULL AFTER location');
  } catch (err) {
    // Column already exists — ignore
  }

  // 3b. Add group_size column if it doesn't exist
  try {
    await db.execute('ALTER TABLE bookings ADD COLUMN group_size INT DEFAULT 1 AFTER staff_id');
  } catch (err) {
    // Column already exists — ignore
  }

  // 4. Seed staff if table is empty
  const [[{ count }]] = await db.execute('SELECT COUNT(*) as count FROM staff');
  if (count === 0) {
    const seed = [
      { name: 'Terapeuta A', location: 'saldanha', days: [0,1,2,3,4,5,6] },
      { name: 'Terapeuta B', location: 'saldanha', days: [0,1,2,3,4,5,6] },
      { name: 'Terapeuta A', location: 'caparica', days: [0,1,2,3,4,5,6] },
      { name: 'Terapeuta B', location: 'caparica', days: [0,1,2,3,4,5,6] },
      { name: 'Terapeuta C', location: 'caparica', days: [0,3,5,6] },
    ];
    for (const s of seed) {
      const [result] = await db.execute(
        'INSERT INTO staff (name, location) VALUES (?, ?)',
        [s.name, s.location]
      );
      for (const day of s.days) {
        await db.execute(
          'INSERT IGNORE INTO staff_schedule (staff_id, day_of_week) VALUES (?, ?)',
          [result.insertId, day]
        );
      }
    }
    console.log('Staff seeded successfully.');
  }
}

async function assignUnassigned() {
  function toMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

  const [unassigned] = await db.execute(
    `SELECT ref, location, date, time, duration FROM bookings
     WHERE status = 'confirmed' AND staff_id IS NULL`
  );
  if (unassigned.length === 0) return;
  console.log(`Auto-assigning therapists to ${unassigned.length} unassigned confirmed booking(s)...`);

  for (const booking of unassigned) {
    const dayOfWeek = new Date(booking.date + 'T12:00:00').getDay();
    const [staffRows] = await db.execute(
      `SELECT s.id FROM staff s
       JOIN staff_schedule ss ON ss.staff_id = s.id
       WHERE s.location = ? AND s.active = 1 AND ss.day_of_week = ?`,
      [booking.location, dayOfWeek]
    );
    const [conflicts] = await db.execute(
      `SELECT staff_id, time, duration FROM bookings
       WHERE location = ? AND date = ? AND status != 'cancelled'
         AND staff_id IS NOT NULL AND ref != ?`,
      [booking.location, booking.date, booking.ref]
    );
    const bStart = toMins(booking.time);
    const bEnd   = bStart + parseInt(booking.duration) + 15;
    const busyIds = new Set(
      conflicts
        .filter(c => {
          const cStart = toMins(c.time);
          const cEnd   = cStart + parseInt(c.duration) + 15;
          return bStart < cEnd && bEnd > cStart;
        })
        .map(c => Number(c.staff_id))
    );
    const freeStaff = staffRows.filter(s => !busyIds.has(Number(s.id)));
    if (freeStaff.length > 0) {
      const assigned = freeStaff[Math.floor(Math.random() * freeStaff.length)];
      await db.execute('UPDATE bookings SET staff_id = ? WHERE ref = ?', [assigned.id, booking.ref]);
      console.log(`  Assigned staff ${assigned.id} to booking ${booking.ref}`);
    } else {
      console.log(`  No free therapist found for booking ${booking.ref} (${booking.date} ${booking.time})`);
    }
  }
}

const PORT = process.env.PORT || 3000;
migrate()
  .then(() => assignUnassigned())
  .then(() => {
    app.listen(PORT, () => console.log(`BTM API running on port ${PORT}`));
  }).catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
