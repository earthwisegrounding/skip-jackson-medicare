'use strict';
// Session, login/logout, password, users (admin), settings, meta.

const A = require('../auth');
const C = require('../constants');
const { T } = require('../validate');
const { fail, check, mustGet, auditR, changedFields, created } = require('./helpers');
const S = require('../services');
const { update } = require('../db');
const { TZ } = require('../time');

const LOGIN_FAILED = 'That email and password combination did not work, or the account is temporarily locked. Please try again, or wait 15 minutes.';

const SETTINGS = {
  business_name: { type: T.string(120), label: 'Business name' },
  number_of_products: { type: T.int(0, 9999), label: 'Number of products' },
  number_of_organizations: { type: T.int(0, 999), label: 'Number of organizations' },
  business_hours: { type: T.string(200), label: 'Business hours' },
  office_phone: { type: T.phone(), label: 'Office phone' },
  default_assignee_user_id: { type: T.id(), label: 'Default assignee' },
  retention_years: { type: T.int(1, 50), label: 'Retention years' },
};
const SETTING_DEFAULTS = {
  business_name: 'Skip Jackson, Licensed Insurance Agent', number_of_organizations: '6', business_hours: 'Monday–Friday, 9 AM–5 PM Eastern',
  office_phone: '4043547597', retention_years: '10',
};

function getSettings(db) {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in SETTINGS) out[r.key] = r.value;
  return out;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

function registerAccountRoutes(router, ctx) {
  const { db, cfg } = ctx;

  router.get('/session', (r) => {
    if (!r.session) return { authenticated: false, expired: r.sessionExpired };
    return { authenticated: true, user: r.user, csrf: r.session.csrf, idle_timeout_ms: cfg.sessionIdleMs };
  }, { auth: false });

  // Login throttling (all bookkeeping happens synchronously BEFORE the async password check, so
  // parallel requests can't all slip past the counter):
  //  - per (user, IP): 5 failures -> locked 15 min, doubling on each repeat lock (max 24 h);
  //  - per user overall: 50 failures in an hour -> hard lock for 1 hour (stops distributed guessing);
  //  - per IP and per email: request rate limits.
  const PAIR_MAX = A.MAX_FAILED;
  const USER_HOURLY_MAX = cfg.userHourlyFailMax || 50;

  function reserveAttempt(user, ip) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const hourAgo = new Date(now - 3600e3).toISOString();
    const u = db.prepare(`UPDATE users SET
        failed_attempts = CASE WHEN failed_window_start IS NULL OR failed_window_start < :hourAgo THEN 1 ELSE failed_attempts + 1 END,
        failed_window_start = CASE WHEN failed_window_start IS NULL OR failed_window_start < :hourAgo THEN :now ELSE failed_window_start END
      WHERE id = :id RETURNING failed_attempts, locked_until`).get({ id: user.id, hourAgo, now: nowIso });
    const p = db.prepare(`INSERT INTO login_throttle (user_id, ip, failures, updated_at) VALUES (:id, :ip, 1, :now)
      ON CONFLICT(user_id, ip) DO UPDATE SET failures = failures + 1, updated_at = :now
      RETURNING failures, lock_count, locked_until`).get({ id: user.id, ip, now: nowIso });
    const userLocked = u.locked_until && Date.parse(u.locked_until) > now;
    const pairLocked = p.locked_until && Date.parse(p.locked_until) > now;
    if (!userLocked && u.failed_attempts >= USER_HOURLY_MAX) {
      db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(new Date(now + 3600e3).toISOString(), user.id);
      S.audit(db, { user, action: 'account_locked', entity: 'user', entityId: user.id, summary: `${u.failed_attempts} attempts in an hour (all IPs)`, ip });
    }
    return { blocked: userLocked || pairLocked || p.failures > PAIR_MAX || u.failed_attempts > USER_HOURLY_MAX, pairFailures: p.failures, lockCount: p.lock_count };
  }

  function lockPair(user, ip, lockCount) {
    const ms = Math.min(24 * 3600e3, A.LOCK_MS * (2 ** lockCount));
    db.prepare('UPDATE login_throttle SET failures = 0, lock_count = lock_count + 1, locked_until = ? WHERE user_id = ? AND ip = ?')
      .run(new Date(Date.now() + ms).toISOString(), user.id, ip);
    S.audit(db, { user, action: 'account_locked', entity: 'user', entityId: user.id, summary: `${PAIR_MAX} failed attempts from one address; locked ${Math.round(ms / 60000)} min`, ip });
  }

  router.post('/login', async (r) => {
    if (!ctx.loginLimiter.hit(r.ip)) fail(429, 'rate_limited', { message: 'Too many sign-in attempts. Please wait 15 minutes.' });
    const email = typeof r.body.email === 'string' ? r.body.email.trim().toLowerCase().slice(0, 200) : '';
    const password = typeof r.body.password === 'string' ? r.body.password.slice(0, 500) : '';
    if (!email || !password) fail(400, 'validation', { errors: { email: email ? undefined : 'Please enter your email.', password: password ? undefined : 'Please enter your password.' } });
    if (!ctx.loginEmailLimiter.hit(email)) fail(429, 'rate_limited', { message: 'Too many sign-in attempts. Please wait 15 minutes.' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.active) {
      await A.dummyVerify(password);
      S.audit(db, { action: 'login_failed', summary: user ? 'inactive account' : 'unknown email', ip: r.ip });
      fail(401, 'login_failed', { message: LOGIN_FAILED });
    }
    const reservation = reserveAttempt(user, r.ip); // synchronous: counted before we await anything
    if (reservation.blocked) {
      await A.dummyVerify(password);
      S.audit(db, { user, action: 'login_failed', entity: 'user', entityId: user.id, summary: 'locked or over the attempt limit', ip: r.ip });
      fail(401, 'login_failed', { message: LOGIN_FAILED });
    }
    const ok = await A.verifyPassword(password, user.password_hash);
    // Re-check locks set by concurrent requests while we were hashing.
    const fresh = db.prepare('SELECT u.locked_until AS ul, t.locked_until AS tl FROM users u LEFT JOIN login_throttle t ON t.user_id = u.id AND t.ip = ? WHERE u.id = ?').get(r.ip, user.id);
    const lockedNow = [fresh.ul, fresh.tl].some((x) => x && Date.parse(x) > Date.now());
    if (!ok || lockedNow) {
      if (!ok && reservation.pairFailures >= PAIR_MAX && !lockedNow) lockPair(user, r.ip, reservation.lockCount);
      S.audit(db, { user, action: 'login_failed', entity: 'user', entityId: user.id, summary: ok ? 'locked' : 'wrong password', ip: r.ip });
      fail(401, 'login_failed', { message: LOGIN_FAILED });
    }
    // Success: clear counters. Drop any session the browser already had (fixation defence).
    db.prepare('DELETE FROM login_throttle WHERE user_id = ? AND ip = ?').run(user.id, r.ip);
    if (r.cookies.crm_sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(A.sha256(r.cookies.crm_sid));
    const now = Date.now();
    update(db, 'users', user.id, { failed_attempts: 0, failed_window_start: null, last_login: new Date(now).toISOString() });
    const { token, csrf } = A.createSession(db, user.id, { ip: r.ip, userAgent: r.userAgent, absoluteMs: cfg.sessionAbsoluteMs });
    S.audit(db, { user, action: 'login', entity: 'user', entityId: user.id, ip: r.ip });
    r.res.setHeader('Set-Cookie', A.cookieHeader('crm_sid', token, { secure: r.secure }));
    return { ok: true, user: publicUser(user), csrf, idle_timeout_ms: cfg.sessionIdleMs };
  }, { auth: false });

  router.post('/logout', (r) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(r.session.sessionId);
    auditR(db, r, 'logout', 'user', r.user.id);
    r.res.setHeader('Set-Cookie', A.cookieHeader('crm_sid', '', { secure: r.secure, maxAgeSec: 0 }));
    return { ok: true };
  });

  router.get('/me', (r) => ({ user: r.user }));

  // "Stay signed in": explicitly extends the idle timer (normal requests touch it at most every 30 s).
  router.post('/keepalive', (r) => {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), r.session.sessionId);
    return { ok: true, idle_timeout_ms: cfg.sessionIdleMs };
  });

  router.post('/password', async (r) => {
    const current = typeof r.body.current_password === 'string' ? r.body.current_password : '';
    const next = typeof r.body.new_password === 'string' ? r.body.new_password : '';
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user.id);
    if (!(await A.verifyPassword(current, user.password_hash))) {
      auditR(db, r, 'password_change_failed', 'user', user.id, 'current password incorrect');
      fail(400, 'validation', { errors: { current_password: 'Your current password is not correct.' } });
    }
    const problem = A.passwordProblem(next);
    if (problem) fail(400, 'validation', { errors: { new_password: problem } });
    if (next === current) fail(400, 'validation', { errors: { new_password: 'Choose a password different from your current one.' } });
    update(db, 'users', user.id, { password_hash: await A.hashPassword(next), password_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(user.id, r.session.sessionId);
    auditR(db, r, 'password_change', 'user', user.id, 'other sessions signed out');
    return { ok: true };
  });

  router.get('/meta', () => {
    const users = db.prepare('SELECT id, name, role, active FROM users ORDER BY active DESC, name').all();
    return {
      stages: C.STAGES, topics: C.TOPICS, preferred_contact: C.PREFERRED_CONTACT, meeting_types: C.MEETING_TYPES,
      activity_types: C.ACTIVITY_TYPES, manual_activity_types: C.MANUAL_ACTIVITY_TYPES, appointment_status: C.APPOINTMENT_STATUS,
      soa_products: C.SOA_PRODUCTS, soa_signature_methods: C.SOA_SIGNATURE_METHODS, soa_initiated_by: C.SOA_INITIATED_BY,
      carriers: C.CARRIERS, plan_types: C.PLAN_TYPES, policy_status: C.POLICY_STATUS,
      election_periods: C.ELECTION_PERIODS, consent_channels: C.CONSENT_CHANNELS, consent_sources: C.CONSENT_SOURCES,
      task_priorities: C.TASK_PRIORITIES, roles: C.ROLES, web_consent: { version: C.WEB_CONSENT_VERSION, text: C.WEB_CONSENT_TEXT },
      users, settings: getSettings(db), timezone: TZ, idle_timeout_ms: cfg.sessionIdleMs,
    };
  });

  // ---------- Users (admin) ----------
  const userSchema = {
    name: { type: T.string(80), required: true, label: 'Name' },
    email: { type: T.email(), required: true, label: 'Email' },
    role: { type: T.enum(['admin', 'agent']), required: true, label: 'Role' },
  };
  const admin = { role: 'admin' };

  router.get('/users', () => ({
    items: db.prepare(`SELECT id, name, email, role, active, last_login, locked_until, failed_attempts, created_at,
        (locked_until > :now OR EXISTS (SELECT 1 FROM login_throttle t WHERE t.user_id = users.id AND t.locked_until > :now)) AS locked
      FROM users ORDER BY active DESC, name`).all({ now: new Date().toISOString() }),
  }), admin);

  router.post('/users', async (r) => {
    const v = check(userSchema, r.body);
    const problem = A.passwordProblem(r.body.password);
    if (problem) fail(400, 'validation', { errors: { password: problem } });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(v.email)) fail(400, 'validation', { errors: { email: 'A user with this email already exists.' } });
    const now = new Date().toISOString();
    const info = db.prepare('INSERT INTO users (name, email, role, password_hash, active, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
      .run(v.name, v.email, v.role, await A.hashPassword(r.body.password), now, now, now);
    const id = Number(info.lastInsertRowid);
    auditR(db, r, 'create', 'user', id, `role=${v.role}`);
    return created({ id });
  }, admin);

  function activeAdmins() {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
  }

  router.patch('/users/:id', (r) => {
    const u = mustGet(db, 'users', r.params.id, 'user');
    const v = check({ ...userSchema, active: { type: T.bool() } }, r.body, { partial: true });
    if (v.email && v.email !== u.email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(v.email, u.id)) {
      fail(400, 'validation', { errors: { email: 'A user with this email already exists.' } });
    }
    const losingAdmin = u.role === 'admin' && u.active && ((v.role && v.role !== 'admin') || v.active === 0);
    if (losingAdmin && activeAdmins() <= 1) fail(400, 'validation', { errors: { role: 'There must be at least one active admin.' } });
    const changed = changedFields(u, v);
    if (!changed.length) return { ok: true };
    update(db, 'users', u.id, { ...v, updated_at: new Date().toISOString() });
    if (v.active === 0 || (v.role && v.role !== u.role)) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    const action = v.active === 0 && u.active ? 'deactivate' : v.active === 1 && !u.active ? 'reactivate' : 'update';
    auditR(db, r, action, 'user', u.id, `fields: ${changed.join(', ')}`);
    return { ok: true };
  }, admin);

  router.post('/users/:id/reset-password', async (r) => {
    const u = mustGet(db, 'users', r.params.id, 'user');
    const problem = A.passwordProblem(r.body.password);
    if (problem) fail(400, 'validation', { errors: { password: problem } });
    db.prepare('DELETE FROM login_throttle WHERE user_id = ?').run(u.id);
    update(db, 'users', u.id, { password_hash: await A.hashPassword(r.body.password), failed_attempts: 0, locked_until: null, password_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(u.id, r.session.sessionId);
    auditR(db, r, 'password_reset', 'user', u.id);
    return { ok: true };
  }, admin);

  router.post('/users/:id/unlock', (r) => {
    const u = mustGet(db, 'users', r.params.id, 'user');
    update(db, 'users', u.id, { failed_attempts: 0, failed_window_start: null, locked_until: null });
    db.prepare('DELETE FROM login_throttle WHERE user_id = ?').run(u.id);
    auditR(db, r, 'unlock', 'user', u.id);
    return { ok: true };
  }, admin);

  // ---------- Settings ----------
  router.get('/settings', () => ({ settings: getSettings(db) }));

  router.put('/settings', (r) => {
    const v = check(SETTINGS, r.body, { partial: true });
    if (v.default_assignee_user_id && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(v.default_assignee_user_id)) {
      fail(400, 'validation', { errors: { default_assignee_user_id: 'Choose an active user.' } });
    }
    const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, val] of Object.entries(v)) stmt.run(k, val === null ? '' : String(val));
    auditR(db, r, 'update', 'settings', null, `fields: ${Object.keys(v).join(', ')}`);
    return { settings: getSettings(db) };
  }, admin);
}

module.exports = { registerAccountRoutes, getSettings, LOGIN_FAILED };
