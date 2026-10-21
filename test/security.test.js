'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { startServer, createUser, request, login } = require('./helpers');

/** Send a raw request line so the client can't normalise "../" away. */
function rawGet(base, rawPath) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), '127.0.0.1', () => sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => resolve({ status: Number(data.split(' ')[1]), raw: data }));
    sock.on('error', reject);
  });
}

test('CSRF, origin checks and RBAC', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await createUser(s.db, { email: 'admin@example.com', name: 'Admin', role: 'admin' });
  await createUser(s.db, { email: 'agent@example.com', name: 'Agent', role: 'agent' });
  const admin = await login(s.base, 'admin@example.com');
  const agent = await login(s.base, 'agent@example.com');
  const created = await admin.post('/contacts', { first_name: 'Rita', last_name: 'Rules', phone: '4045550160' });
  assert.equal(created.status, 201);
  const cid = created.json.id;

  await t.test('state-changing requests need the X-CSRF-Token header', async () => {
    let r = await request(s.base, 'POST', '/crm/api/contacts', { json: { first_name: 'No', last_name: 'Token' }, headers: { cookie: admin.cookie } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'csrf');
    r = await request(s.base, 'POST', '/crm/api/contacts', { json: { first_name: 'Bad', last_name: 'Token' }, headers: { cookie: admin.cookie, 'x-csrf-token': 'x'.repeat(43) } });
    assert.equal(r.status, 403);
    r = await request(s.base, 'POST', '/crm/api/contacts', { json: { first_name: 'Other', last_name: 'Session' }, headers: { cookie: admin.cookie, 'x-csrf-token': agent.csrf } });
    assert.equal(r.status, 403, "another session's token is rejected");
    r = await request(s.base, 'DELETE', `/crm/api/tasks/1`, { headers: { cookie: admin.cookie } });
    assert.equal(r.status, 403);
    r = await admin.post('/contacts', { first_name: 'With', last_name: 'Token' });
    assert.equal(r.status, 201);
  });

  await t.test('cross-site Origin / Sec-Fetch-Site are refused', async () => {
    let r = await admin.post('/contacts', { first_name: 'Evil', last_name: 'Site' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'bad_origin');
    r = await admin.post('/contacts', { first_name: 'Evil', last_name: 'Site' }, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403);
    r = await request(s.base, 'POST', '/crm/api/login', { json: { email: 'admin@example.com', password: 'x' }, headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403, 'login protected too');
    r = await admin.post('/contacts', { first_name: 'Same', last_name: 'Origin' }, { headers: { origin: s.base, 'sec-fetch-site': 'same-origin' } });
    assert.equal(r.status, 201);
  });

  await t.test('non-JSON bodies are refused', async () => {
    const r = await request(s.base, 'POST', '/crm/api/contacts', { body: 'first_name=a&last_name=b', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
    const big = await admin.post('/contacts', { first_name: 'Big', last_name: 'Body', current_coverage: 'x'.repeat(110 * 1024) });
    assert.equal(big.status, 413);
  });

  await t.test('agents cannot export, permanently delete, or manage users/settings', async () => {
    for (const name of ['contacts', 'policies', 'consents']) {
      const r = await agent.get(`/export/${name}.csv`);
      assert.equal(r.status, 403, `export ${name}`);
    }
    assert.equal((await agent.del(`/contacts/${cid}`, { confirm_name: 'Rita Rules' })).status, 403);
    assert.equal((await agent.get('/users')).status, 403);
    assert.equal((await agent.post('/users', { name: 'X', email: 'x@example.com', role: 'admin', password: 'long-enough-password' })).status, 403);
    assert.equal((await agent.patch('/users/1', { role: 'agent' })).status, 403);
    assert.equal((await agent.put('/settings', { number_of_products: 5 })).status, 403);
    assert.equal((await agent.get('/audit')).status, 403);
    assert.equal((await agent.get('/reports')).status, 403);
    // ...but can archive and unarchive
    assert.equal((await agent.post(`/contacts/${cid}/archive`)).status, 200);
    assert.equal((await agent.post(`/contacts/${cid}/unarchive`)).status, 200);
  });

  await t.test('agents cannot delete SOAs; admins must give a reason', async () => {
    const appt = await agent.post('/appointments', { contact_id: cid, starts_at: new Date(Date.now() + 5 * 864e5).toISOString(), type: 'phone' });
    assert.equal(appt.status, 201);
    const soa = await agent.post('/soas', { contact_id: cid, appointment_id: appt.json.id, products: ['medicare_advantage'], signature_method: 'electronic', signed_at: new Date().toISOString(), initiated_by: 'agent' });
    assert.equal(soa.status, 201);
    assert.equal((await agent.del(`/soas/${soa.json.id}`, { reason: 'mistake entry' })).status, 403);
    assert.equal((await agent.del(`/appointments/${appt.json.id}`)).status, 403, 'agents never delete appointments');
    assert.equal((await admin.del(`/soas/${soa.json.id}`, {})).status, 400);
    assert.equal((await admin.del(`/soas/${soa.json.id}`, { reason: 'Entered on the wrong person' })).status, 200);
    const a = s.db.prepare("SELECT summary FROM audit_log WHERE action = 'delete' AND entity = 'soa'").get();
    assert.match(a.summary, /wrong person/);
  });

  await t.test('activities: only creator or admin may edit; web_form/system immutable', async () => {
    const note = await agent.post(`/contacts/${cid}/activities`, { type: 'note', body: 'agent note' });
    assert.equal(note.status, 201);
    const other = await createUser(s.db, { email: 'agent2@example.com', name: 'Agent Two', role: 'agent' });
    assert.ok(other);
    const agent2 = await login(s.base, 'agent2@example.com');
    assert.equal((await agent2.patch(`/activities/${note.json.id}`, { body: 'hijack' })).status, 403);
    assert.equal((await agent.patch(`/activities/${note.json.id}`, { body: 'edited' })).status, 200);
    assert.equal((await admin.del(`/activities/${note.json.id}`)).status, 200);
    assert.ok(s.db.prepare('SELECT deleted_at FROM activities WHERE id = ?').get(note.json.id).deleted_at, 'soft-deleted');
    const sys = s.db.prepare("SELECT id FROM activities WHERE contact_id = ? AND type = 'system' LIMIT 1").get(cid);
    assert.equal((await admin.patch(`/activities/${sys.id}`, { body: 'x' })).status, 403);
    assert.equal((await admin.del(`/activities/${sys.id}`)).status, 403);
  });

  await t.test('admin permanent delete requires the typed full name, anonymizes, keeps consent + audit', async () => {
    await admin.post(`/contacts/${cid}/consents`, { channels: ['text'], granted: false, source: 'text_reply', notes: 'STOP' });
    let r = await admin.del(`/contacts/${cid}`, { confirm_name: 'Rita' });
    assert.equal(r.status, 400);
    r = await admin.del(`/contacts/${cid}`, { confirm_name: '  rita   rules ' });
    assert.equal(r.status, 200);
    const row = s.db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
    assert.ok(row.deleted_at);
    assert.equal(row.first_name, 'Deleted');
    assert.equal(row.phone, null);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE contact_id = ?').get(cid).n, 0, 'working records removed');
    const consents = s.db.prepare('SELECT * FROM consents WHERE contact_id = ?').all(cid);
    assert.ok(consents.length, 'consent history kept');
    assert.ok(consents.every((x) => x.phone === null && x.ip === null), 'consent PII cleared');
    assert.equal((await admin.get(`/contacts/${cid}`)).status, 404);
    const list = await admin.get('/contacts?archived=all&q=Rita');
    assert.equal(list.json.total, 0);
    const a = s.db.prepare("SELECT * FROM audit_log WHERE action = 'delete' AND entity = 'contact' AND entity_id = ?").get(cid);
    assert.ok(a);
    assert.doesNotMatch(a.summary, /Rita/, 'no PII in audit summary');
  });

  await t.test('admin export is audited and CSV-injection safe', async () => {
    const c = await admin.post('/contacts', { first_name: '=HYPERLINK("http://evil")', last_name: '+Cmd', email: 'csv@example.com', tags: '@SUM(1)' });
    assert.equal(c.status, 201);
    const r = await admin.get('/export/contacts.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.body, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
    assert.match(r.body, /,'\+Cmd,/);
    assert.match(r.body, /'@SUM\(1\)/);
    assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'export' AND entity = 'contacts'").get());
  });

  await t.test('viewing a contact is audited', async () => {
    const c = await admin.post('/contacts', { first_name: 'View', last_name: 'Me' });
    await agent.get(`/contacts/${c.json.id}`);
    const row = s.db.prepare("SELECT * FROM audit_log WHERE action = 'view' AND entity_id = ?").get(c.json.id);
    assert.equal(row.user_name, 'Agent');
  });

  await t.test('cannot remove the last active admin', async () => {
    const me = admin.user.id;
    const r = await admin.patch(`/users/${me}`, { active: false });
    assert.equal(r.status, 400);
  });
});

test('security headers and static serving', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  await t.test('public pages: CSP permitting Google Fonts + YouTube, plus baseline headers', async () => {
    const r = await request(s.base, 'GET', '/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
    assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com/);
    assert.match(csp, /img-src 'self' data: https:\/\/i\.ytimg\.com/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.match(r.headers.get('content-type'), /text\/html/);
  });

  await t.test('CRM: strict CSP, noindex, no-store API', async () => {
    const r = await request(s.base, 'GET', '/crm/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'none'"]) {
      assert.ok(csp.includes(d), d);
    }
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(r.headers.get('x-robots-tag'), /noindex/);
    assert.doesNotMatch(r.body, /<script>|\son[a-z]+=|style=/i, 'no inline scripts, handlers or styles');
    const api = await request(s.base, 'GET', '/crm/api/session');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.match(api.headers.get('x-robots-tag'), /noindex/);
    const red = await request(s.base, 'GET', '/crm');
    assert.equal(red.status, 301);
  });

  await t.test('static assets: content types and short cache', async () => {
    const css = await request(s.base, 'GET', '/assets/css/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(css.headers.get('cache-control'), /max-age=3600/);
    const js = await request(s.base, 'GET', '/crm/app.js');
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    assert.equal(js.headers.get('cache-control'), 'no-cache');
    const svg = await request(s.base, 'GET', '/assets/img/favicon.svg');
    assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
    const etag = css.headers.get('etag');
    const again = await request(s.base, 'GET', '/assets/css/styles.css', { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
  });

  await t.test('directories redirect to a trailing slash and serve index.html', async () => {
    const pub = fs.mkdtempSync(path.join(s.dataDir, 'pub-'));
    fs.mkdirSync(path.join(pub, 'about'));
    fs.writeFileSync(path.join(pub, 'about', 'index.html'), '<!doctype html><title>About</title>');
    fs.writeFileSync(path.join(pub, '404.html'), '<!doctype html><title>Missing</title><h1>Not here</h1>');
    fs.writeFileSync(path.join(pub, '.env'), 'SECRET=1');
    const s2 = await startServer({ publicDir: pub });
    try {
      let r = await request(s2.base, 'GET', '/about');
      assert.equal(r.status, 301);
      assert.equal(r.headers.get('location'), '/about/');
      for (const p of ['//about', '/%2Fabout', '/about%2F..%2Fabout']) {
        const raw = await rawGet(s2.base, p);
        const loc = /\r\nLocation: ([^\r]*)/i.exec(raw.raw);
        if (loc) assert.equal(loc[1], '/about/', `open redirect via ${p}`);
      }
      const crm = await rawGet(s2.base, '/crm//evil.example');
      assert.doesNotMatch(crm.raw, /Location: \/\//i);
      r = await request(s2.base, 'GET', '/about/');
      assert.equal(r.status, 200);
      assert.match(r.body, /About/);
      r = await request(s2.base, 'GET', '/nope/');
      assert.equal(r.status, 404);
      assert.match(r.body, /Not here/, 'custom 404 page');
      r = await request(s2.base, 'GET', '/.env');
      assert.equal(r.status, 404);
      assert.doesNotMatch(r.body, /SECRET/);
    } finally {
      await s2.close();
    }
  });

  await t.test('path traversal is blocked', async () => {
    const attempts = ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/assets/..%2f..%2fserver%2fapp.js', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/assets/%5c..%5c..%5cpackage.json', '/crm/..%2fserver%2fapp.js', '/crm/%2e%2e/package.json', '/.git/config', '/%00index.html', '/%E0%A4%A'];
    for (const p of attempts) {
      const r = await rawGet(s.base, p);
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.raw, /"scripts"|createApp|\[core\]|root:/, `${p} leaked content`);
    }
  });

  await t.test('lead endpoint: X-Forwarded-For ignored unless TRUST_PROXY=1', async () => {
    const s3 = await startServer({ trustProxy: false });
    try {
      const body = (i) => ({ first_name: 'P', last_name: 'X', email: `p${i}@example.com`, form_started_at: String(Date.now() - 60000) });
      for (let i = 0; i < 5; i++) {
        const r = await request(s3.base, 'POST', '/api/leads', { json: body(i), headers: { 'x-forwarded-for': `10.0.0.${i}` } });
        assert.equal(r.status, 201);
      }
      const r = await request(s3.base, 'POST', '/api/leads', { json: body(9), headers: { 'x-forwarded-for': '10.0.0.99' } });
      assert.equal(r.status, 429, 'spoofed XFF does not bypass the limit');
    } finally {
      await s3.close();
    }
  });
});
