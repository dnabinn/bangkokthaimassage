-- Bangkok Thai Massage — MySQL Schema
-- Run this once in Hostinger phpMyAdmin:
--   1. Log in to hPanel → Databases → phpMyAdmin
--   2. Select your database (left sidebar)
--   3. Click "SQL" tab → paste this → click "Go"

-- ── BOOKINGS ──
CREATE TABLE IF NOT EXISTS bookings (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  ref               VARCHAR(20)    NOT NULL UNIQUE,
  location          ENUM('saldanha','caparica') NOT NULL,
  service           VARCHAR(100)   NOT NULL,
  duration          SMALLINT       NOT NULL,
  price             DECIMAL(8,2)   NOT NULL,
  date              DATE           NOT NULL,
  time              VARCHAR(5)     NOT NULL,
  name              VARCHAR(100)   NOT NULL,
  email             VARCHAR(100)   NOT NULL,
  phone             VARCHAR(25)    NOT NULL,
  notes             TEXT,
  payment_intent_id VARCHAR(120),
  pay_method        ENUM('card','mbway','whatsapp','unknown') NOT NULL DEFAULT 'card',
  status            ENUM('pending','confirmed','cancelled')   NOT NULL DEFAULT 'confirmed',
  created_at        DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_date     (date),
  INDEX idx_location (location)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── BLOCKED SLOTS ──
-- Auto-populated on each confirmed booking.
-- Staff can also insert rows here manually to block lunch breaks, days off, etc.
CREATE TABLE IF NOT EXISTS blocked_slots (
  id        INT  AUTO_INCREMENT PRIMARY KEY,
  location  ENUM('saldanha','caparica') NOT NULL,
  date      DATE NOT NULL,
  time      VARCHAR(5) NOT NULL,
  UNIQUE KEY unique_slot (location, date, time),
  INDEX idx_location_date (location, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
