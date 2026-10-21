'use strict';
// Password hashing, sessions, CSRF, lockout.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 200;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Used to spend the same time when the email is unknown. Computed once at startup.
let dummyHash = null;
function warmDummyHash() {
  if (!dummyHash) dummyHash = hashPassword('not-a-real-password-' + crypto.randomBytes(8).toString('hex'));
  return dummyHash;
}
async function dummyVerify(password) {
  await verifyPassword(String(password || ''), await warmDummyHash());
  return false;
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return `Password must be ${MAX_PASSWORD} characters or fewer.`;
  if (/^(.)\1+$/.test(pw)) return 'Please choose a less predictable password.';
  return null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

function createSession(db, userId, { ip, userAgent, absoluteMs }) {
  const token = randomToken();
  const csrf = randomToken();
  const now = new Date();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(token), userId, csrf, now.toISOString(), now.toISOString(),
    new Date(now.getTime() + absoluteMs).toISOString(), ip || null, (userAgent || '').slice(0, 200) || null);
  return { token, csrf };
}

/** Look up a session by raw cookie token; enforces idle + absolute expiry and touches last_seen. */
function loadSession(db, token, { idleMs, touch = true }) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const hash = sha256(token);
  const row = db.prepare(`SELECT s.id AS session_id, s.csrf_token, s.last_seen_at, s.expires_at, s.created_at AS session_created,
      u.id, u.name, u.email, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
  if (!row) return null;
  const now = Date.now();
  if (!row.active || Date.parse(row.expires_at) <= now || Date.parse(row.last_seen_at) + idleMs <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return { expired: true };
  }
  // Avoid a write on every request: touch at most every 30 seconds.
  if (touch && now - Date.parse(row.last_seen_at) > 30000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.session_id);
  }
  return {
    sessionId: row.session_id, csrf: row.csrf_token,
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
  };
}

function purgeExpiredSessions(db, idleMs) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?')
    .run(new Date(now).toISOString(), new Date(now - idleMs).toISOString());
}

function cookieHeader(name, value, { secure, maxAgeSec }) {
  const parts = [`${name}=${value}`, 'Path=/crm', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

module.exports = {
  hashPassword, verifyPassword, dummyVerify, warmDummyHash, passwordProblem, sha256, randomToken, safeEqual,
  createSession, loadSession, purgeExpiredSessions, cookieHeader, MIN_PASSWORD, MAX_FAILED, LOCK_MS,
};
