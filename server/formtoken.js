'use strict';
// Server-signed form tokens for the public lead forms (bot timing check that can't be faked client-side).
// Token format: "<issued_at ms>.<base64url HMAC-SHA256(secret, 'form:' + issued_at)>".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_AGE_MS = 24 * 3600 * 1000;

function loadSecret(dataDir) {
  const file = path.join(dataDir, 'form-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return Buffer.from(s, 'base64url');
  } catch { /* create below */ }
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString('base64url'), { mode: 0o600, flag: 'w' });
  return secret;
}

function createFormTokens(dataDir) {
  const secret = loadSecret(dataDir);
  const sign = (issuedAt) => crypto.createHmac('sha256', secret).update(`form:${issuedAt}`).digest('base64url');
  return {
    issue(now = Date.now()) { return { token: `${now}.${sign(now)}`, issued_at: now }; },
    /** {valid, issuedAt, reason} */
    verify(token, now = Date.now()) {
      const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
      if (!m) return { valid: false, reason: token ? 'malformed form token' : 'missing form token' };
      const issuedAt = Number(m[1]);
      const expected = Buffer.from(sign(issuedAt));
      const got = Buffer.from(m[2]);
      if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { valid: false, reason: 'invalid form token' };
      if (issuedAt > now + 60000 || now - issuedAt > MAX_AGE_MS) return { valid: false, reason: 'expired form token' };
      return { valid: true, issuedAt };
    },
  };
}

module.exports = { createFormTokens, MAX_AGE_MS };
