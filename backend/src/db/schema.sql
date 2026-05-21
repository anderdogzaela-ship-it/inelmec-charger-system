-- =============================================================================
-- INELMEC Charger System — Database Schema
-- =============================================================================
-- SQLite for the MVP. Schema is portable to PostgreSQL with minor type swaps:
--   INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL/BIGSERIAL PRIMARY KEY
--   TEXT (UUID columns)               -> UUID
--   TEXT (timestamps)                 -> TIMESTAMPTZ
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- -----------------------------------------------------------------------------
-- locations: residential complex, hotel, or parking lot hosting chargers.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  address         TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- chargers: a physical EV charger tied to a Tuya device.
--   qr_code        — printed on the physical charger; what the user scans.
--   tuya_device_id — Tuya Cloud device identifier (visible in cloud.tuya.com).
--   tuya_switch_dp — the device's "switch" datapoint code. Common values:
--                    "switch_1", "switch", "switch_led_1" depending on the
--                    specific charger model. Determined during commissioning.
--   rate_cop_per_hour — what a user pays per hour, in Colombian pesos.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chargers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id          INTEGER NOT NULL REFERENCES locations(id),
  qr_code              TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  tuya_device_id       TEXT NOT NULL UNIQUE,
  tuya_switch_dp       TEXT NOT NULL DEFAULT 'switch_1',
  rate_cop_per_hour    INTEGER NOT NULL,
  min_minutes          INTEGER NOT NULL DEFAULT 30,
  max_minutes          INTEGER NOT NULL DEFAULT 240,
  status               TEXT NOT NULL DEFAULT 'available'
                       CHECK (status IN ('available','occupied','offline','maintenance')),
  online               INTEGER NOT NULL DEFAULT 1,
  last_seen_at         TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chargers_status ON chargers(status);

-- -----------------------------------------------------------------------------
-- sessions: one row per "I want to charge" attempt by a user.
--   payment_status — tracks Wompi-side state.
--   activation_status — tracks Tuya-side state.
--   These two are intentionally separate because they fail independently.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,                  -- UUID
  charger_id            INTEGER NOT NULL REFERENCES chargers(id),
  user_phone            TEXT,
  user_email            TEXT,
  amount_cop            INTEGER NOT NULL,                  -- total in COP
  minutes_purchased     INTEGER NOT NULL,
  reference             TEXT NOT NULL UNIQUE,              -- our reference sent to Wompi
  wompi_transaction_id  TEXT UNIQUE,                       -- assigned by Wompi
  payment_status        TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (payment_status IN ('PENDING','APPROVED','DECLINED','VOIDED','ERROR')),
  activation_status     TEXT NOT NULL DEFAULT 'NOT_STARTED'
                        CHECK (activation_status IN (
                          'NOT_STARTED','ACTIVATING','ACTIVE','DEACTIVATING',
                          'COMPLETED','FAILED','TIMEOUT'
                        )),
  activated_at          TEXT,
  expected_end_at       TEXT,
  completed_at          TEXT,
  failure_reason        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_charger     ON sessions(charger_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active      ON sessions(activation_status, expected_end_at);
CREATE INDEX IF NOT EXISTS idx_sessions_created     ON sessions(created_at);

-- -----------------------------------------------------------------------------
-- idempotency_keys: prevents double-activation when Wompi retries a webhook.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            TEXT PRIMARY KEY,
  session_id     TEXT REFERENCES sessions(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- audit_log: immutable trail of every state change. Critical for safety
-- review and Wompi dispute resolution. NEVER UPDATE OR DELETE rows here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(id),
  charger_id   INTEGER REFERENCES chargers(id),
  event_type   TEXT NOT NULL,
  payload      TEXT,                                        -- JSON
  actor        TEXT NOT NULL DEFAULT 'system',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_session  ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_charger  ON audit_log(charger_id);
CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_log(created_at);

-- -----------------------------------------------------------------------------
-- webhook_events: raw Wompi webhook payloads. Stored before any processing
-- so we can replay or investigate signature mismatches.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL,                            -- 'wompi'
  event_type      TEXT,
  signature_valid INTEGER NOT NULL,
  raw_payload     TEXT NOT NULL,
  processed       INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  received_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_processed ON webhook_events(processed);

-- -----------------------------------------------------------------------------
-- admins: panel users.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('admin','operator','viewer')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);
