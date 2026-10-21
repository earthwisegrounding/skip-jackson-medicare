'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, lead } = require('./helpers');
const { WEB_CONSENT_TEXT, WEB_CONSENT_VERSION } = require('../server/constants');

test('public lead intake', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const token = () => s.app.ctx.formTokens.issue(Date.now() - 60000).token;
  const post = (body, ip = s.nextIp(), extra = {}) => request(s.base, 'POST', '/api/leads', {
    json: { form_token: token(), ...body }, headers: { 'x-forwarded-for': ip, 'user-agent': 'TestAgent/1.0', origin: s.base, referer: `${s.base}/contact/` }, ...extra,
  });
  const count = (table) => s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  await t.test('valid JSON lead creates contact, web_form activity, follow-up task and permission-to-contact record', async () => {
    const r = await post(lead());
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { ok: true });
    const c = s.db.prepare("SELECT * FROM contacts WHERE email = 'jane.doe@example.com'").get();
    assert.ok(c);
    assert.equal(c.phone, '4045550142');
    assert.equal(c.stage, 'new');
    assert.equal(c.source, 'website');
    const act = s.db.prepare("SELECT * FROM activities WHERE contact_id = ? AND type = 'web_form'").get(c.id);
    assert.ok(act);
    const meta = JSON.parse(act.meta);
    assert.equal(meta.fields.topic, 'turning-65');
    assert.equal(meta.beneficiary_initiated, true);
    assert.equal(meta.fields.website, undefined, 'honeypot field is not stored');
    const task = s.db.prepare('SELECT * FROM tasks WHERE contact_id = ?').get(c.id);
    assert.equal(task.title, 'Call back Jane Doe');
    const dueMs = Date.parse(task.due_at) - Date.now();
    assert.ok(dueMs > 0 && dueMs < 4 * 864e5, 'due on the next business day');
    const { zonedParts } = require('../server/time');
    const p = zonedParts(new Date(task.due_at));
    assert.deepEqual([p.h, p.mi], [10, 0], '10:00 AM Georgia time');
    assert.ok(p.wd >= 1 && p.wd <= 5);
    assert.equal(task.kind, 'callback');
    const req = s.db.prepare('SELECT * FROM contact_requests WHERE contact_id = ?').get(c.id);
    assert.ok(req.ip);
    assert.equal(req.user_agent, 'TestAgent/1.0');
    assert.equal(count('consents'), 0, 'no consent without the checkbox');
  });

  await t.test('validation errors use the documented keys', async () => {
    let r = await post(lead({ first_name: '', last_name: '', phone: '123', email: 'nope', zip: '3030' }));
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    for (const k of ['first_name', 'last_name', 'phone', 'email', 'zip']) assert.ok(r.json.errors[k], `error for ${k}`);

    r = await post(lead({ phone: '', email: '' }));
    assert.equal(r.status, 400);
    assert.match(r.json.errors.phone, /phone number or an email/);

    r = await post(lead({ phone: '', email: 'only@example.com', consent_texts: 'yes' }));
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.phone, 'consent requires a phone');

    r = await post(lead({ first_name: 'x'.repeat(61) }));
    assert.equal(r.status, 400);
    r = await post(lead({ message: 'x'.repeat(1501) }));
    assert.equal(r.status, 400);
    r = await post(lead({ topic: 'free-cruise' }));
    assert.equal(r.status, 400);
    r = await post(lead({ preferred_contact: 'text', consent_texts: '' }));
    assert.equal(r.status, 400);
    assert.equal(r.json.errors.consent_texts, "Please check the consent box if you'd like text messages, or choose phone or email.");
    r = await post(lead({ phone: '1-404-555-0199', email: 'eleven@example.com' }));
    assert.equal(r.status, 201, '11 digits starting with 1 is accepted');
    for (const [zip, ok] of [['30303-1234', true], ['303031234', true], ['3030', false], ['30303-12', false]]) {
      r = await post(lead({ zip, phone: '', email: `zip${zip.replace(/\D/g, '')}@example.com` }));
      assert.equal(r.status, ok ? 201 : 400, `zip ${zip}`);
    }
    assert.equal(s.db.prepare("SELECT zip FROM contacts WHERE email = 'zip303031234@example.com'").get().zip, '30303');
    r = await post(lead({ topic: '', phone: '', email: 'notopic@example.com' }));
    assert.equal(r.status, 201);
    assert.equal(s.db.prepare("SELECT topic FROM contacts WHERE email = 'notopic@example.com'").get().topic, 'other', 'empty topic -> other');
  });

  await t.test('form-encoded posts redirect', async () => {
    let r = await request(s.base, 'POST', '/api/leads', { form: lead({ email: 'form@example.com', phone: '' }), headers: { 'x-forwarded-for': s.nextIp() } });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/thank-you/');
    r = await request(s.base, 'POST', '/api/leads', { form: lead({ first_name: '' }), headers: { 'x-forwarded-for': s.nextIp() } });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/contact/?error=1#form-error');
  });

  await t.test('honeypot and too-fast submissions pretend success but store nothing', async () => {
    const before = count('contacts');
    let r = await post(lead({ email: 'bot1@example.com', phone: '4045550111', website: 'http://spam.example' }));
    assert.equal(r.status, 201);
    r = await post(lead({ email: 'bot2@example.com', phone: '4045550112', form_started_at: String(Date.now() - 1000) }));
    assert.equal(r.status, 201);
    r = await request(s.base, 'POST', '/api/leads', { form: lead({ email: 'bot3@example.com', website: 'x' }), headers: { 'x-forwarded-for': s.nextIp() } });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/thank-you/');
    assert.equal(count('contacts'), before);
  });

  await t.test('rejects oversized bodies and unsupported types', async () => {
    let r = await post(lead({ message: 'x'.repeat(21 * 1024) }));
    assert.equal(r.status, 413);
    r = await request(s.base, 'POST', '/api/leads', { body: 'hello', headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 415);
    r = await request(s.base, 'GET', '/api/leads');
    assert.equal(r.status, 405);
  });

  await t.test('rate limit: 5 per 10 minutes per IP (X-Forwarded-For trusted only with TRUST_PROXY)', async () => {
    const ip = '192.0.2.77';
    for (let i = 0; i < 5; i++) {
      const r = await post(lead({ email: `rl${i}@example.com`, phone: `40455502${10 + i}` }), ip);
      assert.equal(r.status, 201, `submission ${i + 1}`);
    }
    const r = await post(lead({ email: 'rl-over@example.com', phone: '4045550299' }), ip);
    assert.equal(r.status, 429);
    assert.deepEqual(r.json, { ok: false, error: 'rate_limited' });
    const other = await post(lead({ email: 'rl-other@example.com', phone: '4045550298' }), '192.0.2.78');
    assert.equal(other.status, 201, 'other IPs unaffected');
  });

  await t.test('dedupe by phone or email adds to the existing contact; lost -> new', async () => {
    await post(lead({ first_name: 'Ann', last_name: 'Again', phone: '404-555-0170', email: 'ann@example.com' }));
    const c = s.db.prepare("SELECT * FROM contacts WHERE email = 'ann@example.com'").get();
    s.db.prepare("UPDATE contacts SET stage = 'lost' WHERE id = ?").run(c.id);
    const before = count('contacts');
    let r = await post(lead({ first_name: 'Ann', last_name: 'Again', phone: '(404) 555-0170', email: '' }));
    assert.equal(r.status, 201);
    r = await post(lead({ first_name: 'Ann', last_name: 'Again', phone: '', email: 'ANN@example.com' }));
    assert.equal(r.status, 201);
    assert.equal(count('contacts'), before, 'no duplicate created');
    const after = s.db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id);
    assert.equal(after.stage, 'new');
    const forms = s.db.prepare("SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'web_form'").get(c.id).n;
    assert.equal(forms, 3);
    assert.ok(s.db.prepare("SELECT 1 FROM activities WHERE contact_id = ? AND type = 'stage_change'").get(c.id));

    // A contact in another stage keeps its stage.
    s.db.prepare("UPDATE contacts SET stage = 'comparing_plans' WHERE id = ?").run(c.id);
    await post(lead({ first_name: 'Ann', last_name: 'Again', phone: '4045550170', email: '' }));
    assert.equal(s.db.prepare('SELECT stage FROM contacts WHERE id = ?').get(c.id).stage, 'comparing_plans');
  });

  await t.test('consent_texts=yes records versioned consent with full evidence', async () => {
    const r = await post(lead({ first_name: 'Cal', last_name: 'Consent', phone: '404.555.0181', email: 'cal@example.com', consent_texts: 'yes', form_id: 'contact-page', source_page: '/contact/' }), '192.0.2.50');
    assert.equal(r.status, 201);
    const c = s.db.prepare("SELECT id FROM contacts WHERE email = 'cal@example.com'").get();
    const rows = s.db.prepare('SELECT * FROM consents WHERE contact_id = ? ORDER BY channel').all(c.id);
    assert.deepEqual(rows.map((x) => x.channel), ['automated', 'call', 'text']);
    for (const row of rows) {
      assert.equal(row.granted, 1);
      assert.equal(row.effective, 1, 'verified, same-origin, new contact: effective immediately');
      assert.equal(row.consent_text, WEB_CONSENT_TEXT);
      assert.equal(row.text_version, WEB_CONSENT_VERSION);
      assert.equal(row.phone, '4045550181');
      assert.equal(row.ip, '192.0.2.50');
      assert.equal(row.user_agent, 'TestAgent/1.0');
      assert.equal(row.form_id, 'contact-page');
      assert.equal(row.source_page, '/contact/');
      assert.equal(row.source, 'web_form');
      assert.ok(row.captured_at);
    }
    assert.throws(() => s.db.prepare('UPDATE consents SET granted = 0 WHERE contact_id = ?').run(c.id), /append-only/);
  });

  await t.test('do-not-contact person re-submits: inquiry recorded, DNC kept, dashboard warning raised', async () => {
    await post(lead({ first_name: 'Dee', last_name: 'Nc', phone: '4045550190', email: 'dee@example.com' }));
    const c = s.db.prepare("SELECT * FROM contacts WHERE email = 'dee@example.com'").get();
    s.db.prepare("UPDATE contacts SET do_not_contact = 1, dnc_at = ?, dnc_reason = 'asked', stage = 'lost' WHERE id = ?").run(new Date().toISOString(), c.id);
    const r = await post(lead({ first_name: 'Dee', last_name: 'Nc', phone: '4045550190', email: '' }));
    assert.equal(r.status, 201);
    const after = s.db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id);
    assert.equal(after.do_not_contact, 1, 'DNC flag kept');
    const reqs = s.db.prepare('SELECT * FROM contact_requests WHERE contact_id = ? ORDER BY id').all(c.id);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[1].while_dnc, 1);
  });

  await t.test('never logs request bodies', async () => {
    const lines = [];
    const s2 = await startServer({ quiet: false, logSink: (l) => lines.push(l) });
    try {
      await request(s2.base, 'POST', '/api/leads?email=leak@example.com', { json: lead({ email: 'secret-person@example.com', phone: '4045550177', message: 'my private note' }), headers: { 'x-forwarded-for': '192.0.2.9' } });
    } finally {
      await s2.close();
    }
    const out = lines.join('');
    assert.match(out, /"p":"\/api\/leads"/);
    assert.doesNotMatch(out, /secret-person|private note|5550177|leak@example/);
  });
});
