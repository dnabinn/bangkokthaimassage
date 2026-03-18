-- Bangkok Thai Massage — Supabase Schema
-- Run this in your Supabase SQL editor (Dashboard → SQL Editor → New query)

-- ── BOOKINGS ──
create table if not exists bookings (
  id               uuid        primary key default gen_random_uuid(),
  ref              text        unique not null,
  location         text        not null check (location in ('saldanha', 'caparica')),
  service          text        not null,
  duration         integer     not null,
  price            numeric(8,2) not null,
  date             date        not null,
  time             text        not null,
  name             text        not null,
  email            text        not null,
  phone            text        not null,
  notes            text,
  payment_intent_id text,
  pay_method       text        not null default 'card'
                   check (pay_method in ('card', 'mbway', 'whatsapp', 'unknown')),
  status           text        not null default 'confirmed'
                   check (status in ('pending', 'confirmed', 'cancelled')),
  created_at       timestamptz not null default now()
);

-- ── BLOCKED SLOTS ──
-- Populated automatically on each confirmed booking.
-- Can also be used by staff to manually block out time.
create table if not exists blocked_slots (
  id         uuid  primary key default gen_random_uuid(),
  location   text  not null check (location in ('saldanha', 'caparica')),
  date       date  not null,
  time       text  not null,
  unique (location, date, time)
);

-- ── ROW LEVEL SECURITY ──
-- The backend uses the service_role key which bypasses RLS.
-- Enable RLS so the anon key (used in browser) cannot read bookings.
alter table bookings      enable row level security;
alter table blocked_slots enable row level security;

-- Allow anyone to read blocked_slots (needed for the public slots API if you
-- ever switch to a direct Supabase client in the frontend)
create policy "public can read blocked_slots"
  on blocked_slots for select using (true);

-- Only the service_role (backend) can write
-- (service_role bypasses RLS by default — no extra policy needed)

-- ── INDEXES ──
create index if not exists idx_bookings_date      on bookings (date);
create index if not exists idx_bookings_location  on bookings (location);
create index if not exists idx_blocked_location_date
  on blocked_slots (location, date);
