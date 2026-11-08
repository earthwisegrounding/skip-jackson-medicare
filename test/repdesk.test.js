'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, request, lead } = require('./helpers');
const { WEB_CONSENT_TEXT } = require('../server/constants');

/** A stand-in for RepDesk's inbound form address. `reply` decides each answer. */
async function fakeRepdesk(reply) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, fields: Object.fromEntries(new URLSearchParams(body)) });
      const [status, json] = reply(got.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}/inbound/abcdefghijklmnopqrstuvwx`, close: () => new Promise((r) => server.close(r)) };
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

test('website requests are forwarded to RepDesk', async (t) => {
  let answer = () => [200, { ok: true }];
  const desk = await fakeRepdesk((n) => answer(n));
  const s = await startServer({ repdeskFormUrl: desk.url, publicUrl: 'https://aggressiveseniorsolutions.com' });
  t.after(async () => { await s.close(); await desk.close(); });
  const post = (body) => request(s.base, 'POST', '/api/leads', {
    json: { form_token: s.app.ctx.formTokens.issue(Date.now() - 60000).token, ...body },
    headers: { 'x-forwarded-for': s.nextIp(), origin: s.base, referer: `${s.base}/contact/` },
  });
  const outbox = () => s.db.prepare('SELECT * FROM repdesk_outbox ORDER BY id').all();

  await t.test('a request is stored here and delivered, then its copy is emptied', async () => {
    const r = await post(lead({ consent_texts: 'yes', message: 'Please call after 3pm.' }));
    assert.equal(r.status, 201);
    assert.ok(await until(() => desk.got.length === 1), 'RepDesk received it');
    const f = desk.got[0].fields;
    assert.equal(desk.got[0].path, '/inbound/abcdefghijklmnopqrstuvwx');
    assert.equal(desk.got[0].headers.origin, 'https://aggressiveseniorsolutions.com');
    assert.equal(desk.got[0].headers.accept, 'application/json');
    assert.equal(f.first_name, 'Jane');
    assert.equal(f.phone, '(404) 555-0142');
    assert.equal(f.topic, 'Turning 65');
    assert.equal(f.contact_consent, 'yes');
    assert.equal(f.sms_consent, 'yes');
    assert.match(f.message, /Please call after 3pm\./);
    assert.ok(f.message.includes(WEB_CONSENT_TEXT), 'the exact consent wording travels with it');
    assert.ok(await until(() => outbox()[0].status === 'sent'));
    assert.equal(outbox()[0].payload, '{}', 'personal details dropped once delivered');
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM contacts WHERE email = 'jane.doe@example.com'").get().n, 1, 'still recorded on this site');
  });

  await t.test('no text consent: no sms_consent field', async () => {
    await post(lead({ first_name: 'Sam', email: 'sam@example.com', phone: '4045550199' }));
    assert.ok(await until(() => desk.got.length === 2));
    assert.equal(desk.got[1].fields.sms_consent, undefined);
  });

  await t.test('RepDesk down: kept pending with back-off, nothing lost', async () => {
    answer = () => [502, { error: 'bad gateway' }];
    await post(lead({ first_name: 'Ann', last_name: 'Retry', email: 'ann@example.com', phone: '4045550155' }));
    assert.ok(await until(() => desk.got.length === 3));
    assert.ok(await until(() => outbox()[2].attempts === 1));
    const row = outbox()[2];
    assert.equal(row.status, 'pending');
    assert.match(row.last_error, /HTTP 502/);
    assert.ok(Date.parse(row.next_attempt_at) > Date.now(), 'waits before trying again');
    assert.notEqual(row.payload, '{}', 'the copy is kept until delivered');
    // Back up: once its wait is over, the next flush delivers it.
    answer = () => [200, { ok: true }];
    s.db.prepare('UPDATE repdesk_outbox SET next_attempt_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), row.id);
    await s.app.ctx.repdesk.flush();
    assert.equal(outbox()[2].status, 'sent');
  });

  await t.test('CRM cancelled: marked refused, not retried; the request stays here', async () => {
    answer = () => [403, { ok: false, error: 'crm_inactive' }];
    const r = await post(lead({ first_name: 'Cal', last_name: 'Cancel', email: 'cal@example.com', phone: '4045550166' }));
    assert.equal(r.status, 201, 'the visitor still gets the normal confirmation');
    assert.ok(await until(() => outbox()[3] && outbox()[3].status === 'refused'));
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM contacts WHERE email = 'cal@example.com'").get().n, 1);
  });
});

test('without REPDESK_FORM_URL nothing is sent, and copies wait in the queue', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  assert.equal(s.app.ctx.repdesk.enabled, false);
  const r = await request(s.base, 'POST', '/api/leads', {
    json: { form_token: s.app.ctx.formTokens.issue(Date.now() - 60000).token, ...lead() },
    headers: { 'x-forwarded-for': '198.51.100.9', origin: s.base },
  });
  assert.equal(r.status, 201);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM repdesk_outbox WHERE status = 'pending'").get().n, 1);
});

test('a malformed REPDESK_FORM_URL turns forwarding off', async (t) => {
  const s = await startServer({ repdeskFormUrl: 'https://example.com/not-a-form' });
  t.after(() => s.close());
  assert.equal(s.app.ctx.repdesk.enabled, false);
});
