'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createUser, request, login, PASSWORD } = require('./helpers');
const { sha256 } = require('../server/auth');

test('authentication and sessions', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await createUser(s.db, { email: 'admin@example.com', name: 'Admin', role: 'admin' });
  await createUser(s.db, { email: 'gone@example.com', name: 'Gone', role: 'agent', active: 0 });
  const tryLogin = (email, password, ip = '203.0.113.5') => request(s.base, 'POST', '/crm/api/login', { json: { email, password }, headers: { 'x-forwarded-for': ip } });

  await t.test('API requires a session', async () => {
    const r = await request(s.base, 'GET', '/crm/api/contacts');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'unauthenticated');
    const sess = await request(s.base, 'GET', '/crm/api/session');
    assert.equal(sess.status, 200);
    assert.equal(sess.json.authenticated, false);
  });

  await t.test('login sets a hardened cookie and stores only a hash of the token', async () => {
    const r = await tryLogin('ADMIN@example.com', PASSWORD);
    assert.equal(r.status, 200);
    assert.ok(r.json.csrf);
    assert.equal(r.json.user.email, 'admin@example.com');
    const cookie = r.setCookies.find((c) => c.startsWith('crm_sid='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/crm/);
    assert.doesNotMatch(cookie, /Secure/, 'not Secure over plain http');
    const token = cookie.split(';')[0].split('=')[1];
    assert.ok(Buffer.from(token, 'base64url').length === 32);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token).n, 0, 'raw token not stored');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(sha256(token)).n, 1);
    assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'login'").get());
    const u = s.db.prepare("SELECT last_login FROM users WHERE email = 'admin@example.com'").get();
    assert.ok(u.last_login);
  });

  await t.test('Secure cookie behind an https proxy', async () => {
    const r = await request(s.base, 'POST', '/crm/api/login', { json: { email: 'admin@example.com', password: PASSWORD }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.6' } });
    assert.equal(r.status, 200);
    assert.match(r.setCookies[0], /; Secure/);
    assert.match(r.headers.get('strict-transport-security'), /max-age=/);
  });

  await t.test('wrong password, unknown email and inactive account give the same generic error', async () => {
    const a = await tryLogin('admin@example.com', 'wrong-password-123', '203.0.113.7');
    const b = await tryLogin('nobody@example.com', 'wrong-password-123', '203.0.113.7');
    const c = await tryLogin('gone@example.com', PASSWORD, '203.0.113.7');
    for (const r of [a, b, c]) {
      assert.equal(r.status, 401);
      assert.equal(r.json.error, 'login_failed');
    }
    assert.equal(a.json.message, b.json.message);
    assert.equal(b.json.message, c.json.message);
    s.db.prepare("UPDATE users SET failed_attempts = 0 WHERE email = 'admin@example.com'").run();
  });

  await t.test('lockout after 5 failures for 15 minutes (per user + IP), even with the right password', async () => {
    await createUser(s.db, { email: 'lock@example.com', name: 'Lock', role: 'agent' });
    for (let i = 0; i < 5; i++) assert.equal((await tryLogin('lock@example.com', 'nope-nope-nope', '203.0.113.8')).status, 401);
    const t1 = s.db.prepare("SELECT t.* FROM login_throttle t JOIN users u ON u.id = t.user_id WHERE u.email = 'lock@example.com' AND t.ip = '203.0.113.8'").get();
    assert.ok(Date.parse(t1.locked_until) > Date.now() + 14 * 60e3);
    const r = await tryLogin('lock@example.com', PASSWORD, '203.0.113.8');
    assert.equal(r.status, 401, 'locked account rejects correct password');
    assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'account_locked'").get());
    assert.equal((await tryLogin('lock@example.com', PASSWORD, '203.0.113.99')).status, 200, 'the real user on another network is not locked out (L5)');
    s.db.prepare("UPDATE login_throttle SET locked_until = ? WHERE ip = '203.0.113.8'").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await tryLogin('lock@example.com', PASSWORD, '203.0.113.8')).status, 200, 'works after lock expires');
  });

  await t.test('idle timeout (30 min) and absolute timeout (12 h)', async () => {
    const c = await login(s.base, 'admin@example.com');
    assert.equal((await c.get('/me')).status, 200);
    const hash = sha256(c.cookie.split('=')[1]);
    s.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 31 * 60e3).toISOString(), hash);
    const r = await c.get('/me');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'session_expired');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(hash).n, 0, 'expired session deleted');

    const c2 = await login(s.base, 'admin@example.com');
    const hash2 = sha256(c2.cookie.split('=')[1]);
    s.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 1000).toISOString(), hash2);
    assert.equal((await c2.get('/me')).status, 401);
  });

  await t.test('session polling does not extend the idle timer', async () => {
    const c = await login(s.base, 'admin@example.com');
    const hash = sha256(c.cookie.split('=')[1]);
    const old = new Date(Date.now() - 10 * 60e3).toISOString();
    s.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(old, hash);
    const r = await c.get('/session');
    assert.equal(r.json.authenticated, true);
    assert.equal(s.db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hash).last_seen_at, old);
    await c.get('/me');
    assert.notEqual(s.db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hash).last_seen_at, old);
  });

  await t.test('logout invalidates the session server-side', async () => {
    const c = await login(s.base, 'admin@example.com');
    const r = await c.post('/logout');
    assert.equal(r.status, 200);
    assert.match(r.setCookies[0], /Max-Age=0/);
    assert.equal((await c.get('/me')).status, 401);
  });

  await t.test('password change requires the current password and signs out other sessions', async () => {
    await createUser(s.db, { email: 'pw@example.com', name: 'Pw', role: 'agent' });
    const a = await login(s.base, 'pw@example.com');
    const b = await login(s.base, 'pw@example.com');
    let r = await a.post('/password', { current_password: 'not-it-at-all', new_password: 'a-brand-new-password' });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.current_password);
    r = await a.post('/password', { current_password: PASSWORD, new_password: 'short' });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.new_password);
    r = await a.post('/password', { current_password: PASSWORD, new_password: 'a-brand-new-password' });
    assert.equal(r.status, 200);
    assert.equal((await a.get('/me')).status, 200, 'current session kept');
    assert.equal((await b.get('/me')).status, 401, 'other session signed out');
    assert.equal((await tryLogin('pw@example.com', 'a-brand-new-password', '203.0.113.9')).status, 200);
    const audit = s.db.prepare("SELECT summary FROM audit_log WHERE action = 'password_change'").all();
    assert.ok(audit.length);
    for (const row of s.db.prepare('SELECT summary FROM audit_log').all()) {
      assert.doesNotMatch(String(row.summary), /a-brand-new-password|correct-horse/, 'no passwords in audit log');
    }
  });

  await t.test('stored password hashes are salted scrypt', async () => {
    const rows = s.db.prepare('SELECT password_hash FROM users').all();
    const salts = new Set();
    for (const r of rows) {
      assert.match(r.password_hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
      salts.add(r.password_hash.split('$')[4]);
    }
    assert.equal(salts.size, rows.length, 'per-user salt');
  });
});
