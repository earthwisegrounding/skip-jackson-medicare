'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, createUser, lead } = require('./helpers');

test('CRM_DISABLED: the built-in CRM is off, the website still takes requests', async (t) => {
  const s = await startServer({ crmDisabled: true });
  t.after(() => s.close());
  await createUser(s.db, { email: 'admin@example.com' });

  for (const p of ['/crm', '/crm/', '/crm/index.html', '/crm/app.js', '/login', '/staff']) {
    const r = await request(s.base, 'GET', p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), 'https://desk.digitaldoorwaymarketing.com/login', p);
  }
  for (const [m, p] of [['GET', '/crm/api/me'], ['POST', '/crm/api/login'], ['GET', '/crm/api/contacts']]) {
    const r = await request(s.base, m, p, { json: m === 'POST' ? { email: 'admin@example.com', password: 'x' } : undefined });
    assert.equal(r.status, 410, p);
    assert.equal(r.json.error, 'crm_moved');
    assert.equal(r.setCookies.length, 0, 'no session is ever created');
  }
  assert.equal((await request(s.base, 'POST', '/crm/')).status, 405);

  const r = await request(s.base, 'POST', '/api/leads', {
    json: { form_token: s.app.ctx.formTokens.issue(Date.now() - 60000).token, ...lead() },
    headers: { 'x-forwarded-for': '198.51.100.7', origin: s.base },
  });
  assert.equal(r.status, 201, 'requests are still recorded and queued for RepDesk');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM repdesk_outbox').get().n, 1);
  assert.equal((await request(s.base, 'GET', '/')).status, 200);
  assert.equal((await request(s.base, 'GET', '/events/')).status, 200);
});
