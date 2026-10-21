'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Versioned migrations. Never edit a migration that has shipped; add a new one.
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','agent')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login TEXT,
  password_changed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  phone TEXT,              -- 10 digits, no formatting
  email TEXT,              -- lower-case
  address TEXT,
  city TEXT,
  county TEXT,
  state TEXT NOT NULL DEFAULT 'GA',
  zip TEXT,
  date_of_birth TEXT,      -- YYYY-MM-DD (optional)
  turning_65 TEXT,         -- YYYY-MM (derived from DOB when present)
  medicare_a_effective TEXT,
  medicare_b_effective TEXT,
  current_coverage TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  source TEXT,
  topic TEXT,
  preferred_contact TEXT,
  preferred_time TEXT,
  meeting_type TEXT,
  tags TEXT,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  dnc_reason TEXT,
  dnc_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_phone ON contacts(phone);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_stage ON contacts(stage);
CREATE INDEX idx_contacts_t65 ON contacts(turning_65);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('in','out') OR direction IS NULL),
  body TEXT,
  meta TEXT,               -- JSON (web form fields, stage change details)
  occurred_at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded INTEGER,
  duration_min INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_activities_contact ON activities(contact_id, occurred_at);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  due_at TEXT,
  done_at TEXT,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_due ON tasks(done_at, due_at);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  type TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  notes TEXT,
  soa_id INTEGER REFERENCES scope_of_appointments(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_appointments_start ON appointments(starts_at);

CREATE TABLE scope_of_appointments (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  products TEXT NOT NULL,  -- JSON array
  signature_method TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  exception TEXT,           -- legacy 48-hour-rule exception; no longer used (CMS-4212-F)
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_soa_contact ON scope_of_appointments(contact_id);

CREATE TABLE policies (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,
  plan_name TEXT,
  plan_type TEXT NOT NULL,
  plan_id TEXT,
  effective_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  election_period TEXT,
  application_submitted_at TEXT,
  application_number TEXT,
  premium REAL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_policies_contact ON policies(contact_id);

-- Append-only. Current state per channel = most recent row.
CREATE TABLE consents (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('call','text','email','automated')),
  granted INTEGER NOT NULL,
  phone TEXT,
  email TEXT,
  text_version TEXT,
  consent_text TEXT,
  source TEXT NOT NULL,
  form_id TEXT,
  source_page TEXT,
  notes TEXT,
  captured_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_consents_contact ON consents(contact_id, captured_at);
CREATE TRIGGER consents_no_update BEFORE UPDATE ON consents BEGIN SELECT RAISE(ABORT, 'consents are append-only'); END;

-- Beneficiary-initiated requests for contact (permission to contact), append-only.
CREATE TABLE contact_requests (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL,
  topic TEXT,
  preferred_contact TEXT,
  phone TEXT,
  email TEXT,
  form_id TEXT,
  source_page TEXT,
  ip TEXT,
  user_agent TEXT,
  while_dnc INTEGER NOT NULL DEFAULT 0,
  dnc_reviewed_at TEXT
);
CREATE INDEX idx_contact_requests_contact ON contact_requests(contact_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  summary TEXT,
  ip TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`,
  },
  {
    version: 2,
    name: 'security hardening: consent review, suppression, append-only, revisions, throttling',
    sql: `
-- Consents: rows can be recorded but not yet effective (web consent needing staff review).
ALTER TABLE consents ADD COLUMN effective INTEGER NOT NULL DEFAULT 1;
ALTER TABLE consents ADD COLUMN review_reason TEXT;
ALTER TABLE consents ADD COLUMN accepted_from_id INTEGER;
DROP TRIGGER IF EXISTS consents_no_update;
-- Only allowed change: clearing personal data during a permanent delete (anonymization).
CREATE TRIGGER consents_no_update BEFORE UPDATE ON consents
WHEN NOT (NEW.id IS OLD.id AND NEW.contact_id IS OLD.contact_id AND NEW.channel IS OLD.channel AND NEW.granted IS OLD.granted
  AND NEW.effective IS OLD.effective AND NEW.text_version IS OLD.text_version AND NEW.consent_text IS OLD.consent_text
  AND NEW.source IS OLD.source AND NEW.notes IS OLD.notes AND NEW.captured_at IS OLD.captured_at
  AND NEW.recorded_by_user_id IS OLD.recorded_by_user_id AND NEW.review_reason IS OLD.review_reason
  AND NEW.accepted_from_id IS OLD.accepted_from_id
  AND (NEW.phone IS OLD.phone OR NEW.phone IS NULL) AND (NEW.email IS OLD.email OR NEW.email IS NULL)
  AND (NEW.ip IS OLD.ip OR NEW.ip IS NULL) AND (NEW.user_agent IS OLD.user_agent OR NEW.user_agent IS NULL)
  AND (NEW.form_id IS OLD.form_id OR NEW.form_id IS NULL) AND (NEW.source_page IS OLD.source_page OR NEW.source_page IS NULL))
BEGIN SELECT RAISE(ABORT, 'consents are append-only'); END;
CREATE TRIGGER consents_no_delete BEFORE DELETE ON consents BEGIN SELECT RAISE(ABORT, 'consents are append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

-- Opt-outs keyed by a hash of the phone/email; no foreign key, so they survive a permanent delete.
CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY,
  identifier_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('phone','email')),
  channel TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  source TEXT
);
CREATE INDEX idx_suppressions_hash ON suppressions(identifier_hash, channel);
CREATE TRIGGER suppressions_no_update BEFORE UPDATE ON suppressions BEGIN SELECT RAISE(ABORT, 'suppressions are append-only'); END;
CREATE TRIGGER suppressions_no_delete BEFORE DELETE ON suppressions BEGIN SELECT RAISE(ABORT, 'suppressions are append-only'); END;

-- Website requests: append-only except review fields and anonymization.
ALTER TABLE contact_requests ADD COLUMN origin TEXT;
ALTER TABLE contact_requests ADD COLUMN referer TEXT;
ALTER TABLE contact_requests ADD COLUMN match_type TEXT;
ALTER TABLE contact_requests ADD COLUMN verified INTEGER NOT NULL DEFAULT 1;
ALTER TABLE contact_requests ADD COLUMN submitted_name TEXT;
ALTER TABLE contact_requests ADD COLUMN reviewed_at TEXT;
ALTER TABLE contact_requests ADD COLUMN reviewed_by_user_id INTEGER;
CREATE TRIGGER contact_requests_no_update BEFORE UPDATE ON contact_requests
WHEN NOT (NEW.id IS OLD.id AND NEW.contact_id IS OLD.contact_id AND NEW.requested_at IS OLD.requested_at AND NEW.topic IS OLD.topic
  AND NEW.preferred_contact IS OLD.preferred_contact AND NEW.while_dnc IS OLD.while_dnc AND NEW.match_type IS OLD.match_type
  AND NEW.verified IS OLD.verified
  AND (NEW.activity_id IS OLD.activity_id OR NEW.activity_id IS NULL)
  AND (NEW.phone IS OLD.phone OR NEW.phone IS NULL) AND (NEW.email IS OLD.email OR NEW.email IS NULL)
  AND (NEW.ip IS OLD.ip OR NEW.ip IS NULL) AND (NEW.user_agent IS OLD.user_agent OR NEW.user_agent IS NULL)
  AND (NEW.form_id IS OLD.form_id OR NEW.form_id IS NULL) AND (NEW.source_page IS OLD.source_page OR NEW.source_page IS NULL)
  AND (NEW.origin IS OLD.origin OR NEW.origin IS NULL) AND (NEW.referer IS OLD.referer OR NEW.referer IS NULL)
  AND (NEW.submitted_name IS OLD.submitted_name OR NEW.submitted_name IS NULL))
BEGIN SELECT RAISE(ABORT, 'contact requests are append-only'); END;
CREATE TRIGGER contact_requests_no_delete BEFORE DELETE ON contact_requests BEGIN SELECT RAISE(ABORT, 'contact requests are append-only'); END;

-- Permanent delete anonymizes the contact row instead of removing it.
ALTER TABLE contacts ADD COLUMN deleted_at TEXT;

-- Activity edit history and soft delete.
ALTER TABLE activities ADD COLUMN deleted_at TEXT;
ALTER TABLE activities ADD COLUMN deleted_by INTEGER;
CREATE TABLE activity_revisions (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL,   -- no FK: history survives deletion
  contact_id INTEGER,
  action TEXT NOT NULL CHECK (action IN ('edit','delete')),
  old_values TEXT NOT NULL,       -- JSON of the fields as they were
  user_id INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX idx_activity_revisions ON activity_revisions(activity_id);

-- Appointment status timing (to keep cancellations from hiding compliance problems).
ALTER TABLE appointments ADD COLUMN cancelled_at TEXT;

-- Login throttling per (user, IP), plus a rolling hourly window for the per-user counter.
ALTER TABLE users ADD COLUMN failed_window_start TEXT;
CREATE TABLE login_throttle (
  user_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  lock_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, ip)
);
`,
  },
  {
    version: 3,
    name: 'callback tasks, household links',
    sql: `
ALTER TABLE tasks ADD COLUMN kind TEXT;            -- 'callback' for website call-back tasks
ALTER TABLE contacts ADD COLUMN related_contact_id INTEGER;  -- e.g. possible household member sharing a phone/email
`,
  },
  {
    version: 4,
    name: 'statewide events and RSVPs',
    sql: `
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('educational','marketing')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  starts_at TEXT,                 -- UTC ISO; entered/displayed in Georgia time
  ends_at TEXT,
  format TEXT NOT NULL DEFAULT 'in_person' CHECK (format IN ('in_person','online')),
  venue_name TEXT,
  address TEXT,
  city TEXT,
  county TEXT,
  zip TEXT,
  online_join_info TEXT,          -- only ever shown to people who RSVP, and in the CRM
  summary TEXT,
  description TEXT,               -- plain text, blank-line paragraphs
  accessibility_notes TEXT,
  capacity INTEGER,
  rsvp_enabled INTEGER NOT NULL DEFAULT 1,
  healthcare_setting TEXT NOT NULL DEFAULT 'no' CHECK (healthcare_setting IN ('no','common_area','patient_care_area')),
  carrier_submitted INTEGER NOT NULL DEFAULT 0,
  carrier_refs TEXT,
  refreshments TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_start ON events(status, starts_at);

CREATE TABLE event_rsvps (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  guests INTEGER NOT NULL DEFAULT 0,
  needs_accommodation TEXT,
  contact_permission INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 1,
  ip TEXT,
  user_agent TEXT,
  origin TEXT,
  status TEXT NOT NULL DEFAULT 'going' CHECK (status IN ('going','cancelled')),
  cancelled_at TEXT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_event_rsvps_event ON event_rsvps(event_id, status);
`,
  },
  {
    version: 5,
    name: 'events review: visibility, acknowledgements, RSVP confirmation and retention',
    sql: `
ALTER TABLE events ADD COLUMN public_cancel INTEGER NOT NULL DEFAULT 0;  -- cancelled while published: shown publicly as cancelled
ALTER TABLE events ADD COLUMN gifts_ack INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN pairing_ack INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_rsvps ADD COLUMN confirm_hash TEXT;
ALTER TABLE event_rsvps ADD COLUMN confirm_expires_at TEXT;
ALTER TABLE event_rsvps ADD COLUMN anonymized_at TEXT;
CREATE INDEX idx_event_rsvps_confirm ON event_rsvps(confirm_hash);
UPDATE events SET public_cancel = 1 WHERE status = 'cancelled' AND published_at IS NOT NULL;
`,
  },
];

/** Lower-case, strip accents and punctuation, collapse spaces: "José O'Brien" -> "jose obrien". */
function normText(s) {
  if (s === null || s === undefined) return null;
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, '').replace(/\s+/g, ' ').trim();
}

function openDb(dataDir, file = 'crm.db') {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch { /* not owner */ }
  const dbPath = path.join(dataDir, file);
  const db = new DatabaseSync(dbPath);
  db.function('crm_norm', { deterministic: true }, (s) => normText(s));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.chmodSync(f, 0o600); } catch { /* may not exist yet */ }
  }
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** node:sqlite cannot bind booleans/undefined; normalise a params object. */
function bind(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/** Insert a row from an object; returns new id. Column names come from code, never input. */
function insert(db, table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`;
  return Number(db.prepare(sql).run(bind(row)).lastInsertRowid);
}

function update(db, table, id, row) {
  const cols = Object.keys(row);
  if (!cols.length) return 0;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :__id`;
  return Number(db.prepare(sql).run(bind({ ...row, __id: id })).changes);
}

module.exports = { openDb, migrate, bind, tx, insert, update, MIGRATIONS, normText };
