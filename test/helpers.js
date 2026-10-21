'use strict';
// Test harness: starts the real server on an ephemeral port with a temporary DATA_DIR.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');

const PASSWORD = 'correct-horse-battery-staple';

async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
  const app = createApp({ dataDir, port: 0, host: '127.0.0.1', quiet: true, trustProxy: true, ...overrides });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  let ipCounter = 1;
  return {
    app, db: app.db, base, dataDir,
    /** Unique client IP per call site so rate limits don't bleed between tests. */
    nextIp: () => `198.51.100.${ipCounter++ % 250}`,
    async close() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function createUser(db, { email, name = 'Test User', role = 'admin', password = PASSWORD, active = 1 }) {
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO users (name, email, role, password_hash, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, email, role, await hashPassword(password), active, now, now);
  return Number(info.lastInsertRowid);
}

/** fetch wrapper that never follows redirects and returns {status, headers, body, json, cookies}. */
async function request(base, method, urlPath, { headers = {}, body, json, form } = {}) {
  const h = { ...headers };
  let payload = body;
  if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  const res = await fetch(base + urlPath, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, body: text, json: parsed, setCookies: res.headers.getSetCookie() };
}

/** Log in and return a client that sends the session cookie + CSRF token. */
async function login(base, email, password = PASSWORD, ip = '203.0.113.200') {
  const r = await request(base, 'POST', '/crm/api/login', { json: { email, password }, headers: { 'x-forwarded-for': ip } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.body}`);
  const cookie = r.setCookies.find((c) => c.startsWith('crm_sid=')).split(';')[0];
  const csrf = r.json.csrf;
  const client = {
    cookie, csrf, user: r.json.user,
    call(method, p, opts = {}) {
      const headers = { cookie, ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...(opts.headers || {}) };
      const o = { ...opts, headers };
      if (method !== 'GET' && o.json === undefined && o.body === undefined) o.json = {};
      return request(base, method, `/crm/api${p}`, o);
    },
    get: (p, o) => client.call('GET', p, o),
    post: (p, json, o = {}) => client.call('POST', p, { ...o, json }),
    patch: (p, json, o = {}) => client.call('PATCH', p, { ...o, json }),
    put: (p, json, o = {}) => client.call('PUT', p, { ...o, json }),
    del: (p, json, o = {}) => client.call('DELETE', p, { ...o, json }),
  };
  return client;
}

/** A valid public lead body; form_started_at well in the past so the timing trap doesn't fire. */
function lead(overrides = {}) {
  return {
    first_name: 'Jane', last_name: 'Doe', phone: '(404) 555-0142', email: 'jane.doe@example.com', zip: '30303',
    topic: 'turning-65', preferred_contact: 'phone', form_started_at: String(Date.now() - 60000), form_id: 'home-request',
    source_page: '/', website: '', ...overrides,
  };
}

module.exports = { startServer, createUser, request, login, lead, PASSWORD };
