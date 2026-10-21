'use strict';
// Regression tests for the penetration-test findings (H1-H4, M1-M7, and selected Low items).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createUser, request, login, lead } = require('./helpers');
const { RateLimiter, ipKey } = require('../server/ratelimit');
const { soaCompliance } = require('../server/compliance');

const H = 3600e3;

async function setup(t, overrides) {
  const s = await startServer(overrides);
  t.after(() => s.close());
  await createUser(s.db, { email: 'admin@example.com', name: 'Admin', role: 'admin' });
  await createUser(s.db, { email: 'agent@example.com', name: 'Agent', role: 'agent' });
  const admin = await login(s.base, 'admin@example.com');
  const agent = await login(s.base, 'agent@example.com');
  const token = (ageMs = 60000) => s.app.ctx.formTokens.issue(Date.now() - ageMs).token;
  const post = (body, { ip = s.nextIp(), headers = {}, withToken = true } = {}) => request(s.base, 'POST', '/api/leads', {
    json: withToken ? { form_token: token(), ...body } : body,
    headers: { 'x-forwarded-for': ip, origin: s.base, 'user-agent': 'Hardening/1.0', ...headers },
  });
  return { s, admin, agent, post, token };
}

test('H1 forged consent via the public form', async (t) => {
  const { s, admin, post } = await setup(t);
  const contactByEmail = (e) => s.db.prepare('SELECT * FROM contacts WHERE email = ?').get(e);

  await t.test('DNC contact re-submitting with consent: rows held for review, nothing granted', async () => {
    await post(lead({ first_name: 'Dana', last_name: 'Dnc', phone: '4045550301', email: 'dana@example.com' }));
    const c = contactByEmail('dana@example.com');
    await admin.post(`/contacts/${c.id}/dnc`, { do_not_contact: true, reason: 'asked' });
    const r = await post(lead({ first_name: 'Dana', last_name: 'Dnc', phone: '4045550301', email: '', consent_texts: 'yes' }));
    assert.equal(r.status, 201);
    const rows = s.db.prepare('SELECT * FROM consents WHERE contact_id = ? AND granted = 1').all(c.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((x) => x.effective === 0 && /do-not-contact/.test(x.review_reason)));
    const d = (await admin.get(`/contacts/${c.id}`)).json;
    for (const ch of ['call', 'text', 'email', 'automated']) assert.equal(d.consent_state[ch].granted, false, ch);
    assert.ok(d.activities.some((a) => /Website consent needs review/.test(a.body)));
  });

  await t.test('after STOP, an email-matched request with a different phone does not re-enable texting', async () => {
    await post(lead({ first_name: 'Sam', last_name: 'Stop', phone: '4045550302', email: 'sam.stop@example.com', consent_texts: 'yes' }));
    const c = contactByEmail('sam.stop@example.com');
    assert.equal((await admin.get(`/contacts/${c.id}`)).json.consent_state.text.granted, true);
    await admin.post(`/contacts/${c.id}/consents`, { channels: ['text'], granted: false, source: 'text_reply', notes: 'STOP' });
    await post(lead({ first_name: 'Sam', last_name: 'Stop', phone: '4045550399', email: 'sam.stop@example.com', consent_texts: 'yes' }));
    const d = (await admin.get(`/contacts/${c.id}`)).json;
    assert.equal(d.consent_state.text.granted, false, 'not OK to text');
    const held = s.db.prepare("SELECT review_reason FROM consents WHERE contact_id = ? AND channel = 'text' AND effective = 0").get(c.id);
    assert.match(held.review_reason, /differs|email only|opt-out/);
  });

  await t.test('consent only counts for the contact’s current phone; revocation beats older grants', async () => {
    const c = contactByEmail('sam.stop@example.com');
    // a staff-recorded grant for the current number
    await admin.post(`/contacts/${c.id}/consents`, { channels: ['call'], granted: true, source: 'verbal', consent_text: 'OK to call' });
    assert.equal((await admin.get(`/contacts/${c.id}`)).json.consent_state.call.granted, true);
    await admin.patch(`/contacts/${c.id}`, { phone: '4045550388' });
    assert.equal((await admin.get(`/contacts/${c.id}`)).json.consent_state.call.granted, false, 'grant was for the old number');
  });

  await t.test('staff can accept a pending web consent (audited)', async () => {
    await post(lead({ first_name: 'Pat', last_name: 'Pending', phone: '4045550303', email: 'pat.pending@example.com', consent_texts: 'yes' }), { withToken: false });
    const c = contactByEmail('pat.pending@example.com');
    const pending = s.db.prepare("SELECT * FROM consents WHERE contact_id = ? AND channel = 'text'").get(c.id);
    assert.equal(pending.effective, 0, 'no form token -> held: ' + JSON.stringify(s.db.prepare('SELECT channel, effective, review_reason, source FROM consents WHERE contact_id = ?').all(c.id)));
    assert.equal((await admin.get(`/contacts/${c.id}`)).json.consent_state.text.granted, false);
    const r = await admin.post(`/consents/${pending.id}/accept`, { note: 'Confirmed by phone' });
    assert.equal(r.status, 201);
    assert.equal(r.json.state.text.granted, true);
    assert.equal((await admin.post(`/consents/${pending.id}/accept`, {})).status, 409, 'only once');
    assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'consent_accept' AND entity_id = ?").get(c.id));
  });

  await t.test('suppression survives permanent delete: a re-added person stays opted out', async () => {
    await post(lead({ first_name: 'Gone', last_name: 'Person', phone: '4045550304', email: 'gone@example.com', consent_texts: 'yes' }));
    const c = contactByEmail('gone@example.com');
    await admin.post(`/contacts/${c.id}/consents`, { channels: ['call', 'text', 'automated'], granted: false, source: 'verbal' });
    assert.equal((await admin.del(`/contacts/${c.id}`, { confirm_name: 'Gone Person' })).status, 200);
    await post(lead({ first_name: 'Gone', last_name: 'Person', phone: '4045550304', email: 'gone2@example.com', consent_texts: 'yes' }));
    const again = contactByEmail('gone2@example.com');
    assert.notEqual(again.id, c.id);
    const rows = s.db.prepare('SELECT * FROM consents WHERE contact_id = ?').all(again.id);
    assert.ok(rows.every((x) => x.effective === 0 && /opted out/.test(x.review_reason)));
    assert.equal((await admin.get(`/contacts/${again.id}`)).json.consent_state.text.granted, false);
  });

  await t.test('removing DNC message is accurate: channels stay revoked', async () => {
    const c = contactByEmail('dana@example.com');
    await admin.post(`/contacts/${c.id}/dnc`, { do_not_contact: false, reason: 'Asked to hear from us again' });
    const d = (await admin.get(`/contacts/${c.id}`)).json;
    assert.equal(d.consent_state.text.granted, false);
    assert.ok(d.activities.some((a) => /stays revoked/.test(a.body)));
  });
});

test('H2/L5 login lockout cannot be raced', async (t) => {
  const { s } = await setup(t, { loginEmailLimit: 1000, loginLimit: 1000 });
  await createUser(s.db, { email: 'race@example.com', name: 'Race', role: 'agent' });
  const attempt = (pw, ip = '198.51.100.40') => request(s.base, 'POST', '/crm/api/login', { json: { email: 'race@example.com', password: pw }, headers: { 'x-forwarded-for': ip } });
  const results = await Promise.all(Array.from({ length: 15 }, () => attempt('wrong-password-xyz')));
  assert.ok(results.every((r) => r.status === 401));
  const row = s.db.prepare("SELECT t.* FROM login_throttle t JOIN users u ON u.id = t.user_id WHERE u.email = 'race@example.com'").get();
  assert.ok(row.locked_until && Date.parse(row.locked_until) > Date.now(), 'locked');
  assert.equal((await attempt('correct-horse-battery-staple')).status, 401, 'correct password refused while locked');
  // Progressive: a second lock lasts longer than the first.
  s.db.prepare('UPDATE login_throttle SET locked_until = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), row.user_id);
  await Promise.all(Array.from({ length: 5 }, () => attempt('wrong-again-xyz')));
  const row2 = s.db.prepare('SELECT * FROM login_throttle WHERE user_id = ?').get(row.user_id);
  assert.ok(Date.parse(row2.locked_until) - Date.now() > 25 * 60e3, 'second lock is longer (30 min)');
  // Per-user hard lock after many failures from many addresses.
  await createUser(s.db, { email: 'spray@example.com', name: 'Spray', role: 'agent' });
  for (let i = 0; i < 50; i++) {
    await request(s.base, 'POST', '/crm/api/login', { json: { email: 'spray@example.com', password: 'nope-nope-nope' }, headers: { 'x-forwarded-for': `192.0.2.${i + 1}` } });
  }
  const u = s.db.prepare("SELECT locked_until FROM users WHERE email = 'spray@example.com'").get();
  assert.ok(u.locked_until && Date.parse(u.locked_until) > Date.now(), 'hourly per-user cap locks the account');
});

test('H3 client IP from X-Forwarded-For uses the rightmost trusted hop', async (t) => {
  const { clientIp } = require('../server/http');
  const req = (xff, extra = {}) => ({ headers: { 'x-forwarded-for': xff, ...extra }, socket: { remoteAddress: '10.0.0.1' } });
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.9'), { trustProxy: true }), '203.0.113.9', 'spoofed left entry ignored');
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.9, 10.1.1.1'), { trustProxy: true, proxyHops: 2 }), '203.0.113.9');
  assert.equal(clientIp(req('not-an-ip'), { trustProxy: true }), '10.0.0.1');
  assert.equal(clientIp(req('6.6.6.6'), { trustProxy: false }), '10.0.0.1');
  assert.equal(clientIp(req('6.6.6.6', { 'fly-client-ip': '198.51.100.7' }), { trustProxy: true, trustedClientIpHeader: 'Fly-Client-IP' }), '198.51.100.7');
  assert.equal(clientIp(req('6.6.6.6', { 'fly-client-ip': 'junk' }), { trustProxy: true, trustedClientIpHeader: 'Fly-Client-IP' }), '10.0.0.1');
  const { s, post } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await post(lead({ email: `xff${i}@example.com`, phone: '' }), { ip: `${i}.${i}.${i}.${i}, 203.0.113.77` })).status, 201);
  assert.equal((await post(lead({ email: 'xff9@example.com', phone: '' }), { ip: '9.9.9.9, 203.0.113.77' })).status, 429, 'rotating the spoofable part does not help');
  assert.ok(s);
});

test('H4 SOA and appointment evidence cannot be silently changed', async (t) => {
  const { s, admin, agent } = await setup(t);
  const cid = (await agent.post('/contacts', { first_name: 'Evi', last_name: 'Dence' })).json.id;
  const start = new Date(Date.now() + 2 * H).toISOString();
  const appt = (await agent.post('/appointments', { contact_id: cid, starts_at: start, type: 'phone' })).json.id;
  const soa = (await agent.post('/soas', { contact_id: cid, appointment_id: appt, products: ['part_d'], signature_method: 'electronic', signed_at: new Date().toISOString(), initiated_by: 'agent' })).json.id;

  let r = await agent.patch(`/soas/${soa}`, { signed_at: new Date(Date.now() - 72 * H).toISOString() });
  assert.equal(r.status, 403, 'agent cannot backdate');
  for (const body of [{ products: ['medigap'] }, { signature_method: 'paper' }, { appointment_id: null }]) {
    assert.equal((await agent.patch(`/soas/${soa}`, body)).status, 403, JSON.stringify(body));
  }
  assert.equal((await agent.patch(`/soas/${soa}`, { notes: 'clarified' })).status, 200, 'notes are fine');
  r = await admin.patch(`/soas/${soa}`, { signature_method: 'paper' });
  assert.equal(r.status, 400, 'admin needs a reason');
  r = await admin.patch(`/soas/${soa}`, { signature_method: 'paper', reason: 'Paper form found in file' });
  assert.equal(r.status, 200);
  const act = s.db.prepare("SELECT body FROM activities WHERE contact_id = ? AND body LIKE 'Scope of Appointment #% corrected%'").get(cid);
  assert.match(act.body, /signature_method: electronic → paper/);
  const aud = s.db.prepare("SELECT summary FROM audit_log WHERE entity = 'soa' AND action = 'update' ORDER BY id DESC").get();
  assert.match(aud.summary, /electronic → paper/);

  // Agents can't delete appointments or clear SOA links; status changes are on the timeline.
  assert.equal((await agent.del(`/appointments/${appt}`)).status, 403);
  assert.equal((await agent.patch(`/appointments/${appt}`, { soa_id: null })).status, 403);
  assert.equal((await agent.patch(`/appointments/${appt}`, { type: 'video' })).status, 200);
  assert.ok(s.db.prepare("SELECT 1 FROM activities WHERE contact_id = ? AND body LIKE '%type: phone → video%'").get(cid));

  // Backdating: entered after the start but with an earlier signed_at.
  assert.equal(soaCompliance({ starts_at: '2026-11-01T15:00:00Z', type: 'phone', status: 'completed' },
    { signed_at: '2026-10-30T15:00:00Z', created_at: '2026-11-01T18:00:00Z', signature_method: 'electronic' }).label, 'SOA recorded after appointment start');

  // Cancelling after the start time doesn't hide a missing SOA.
  const past = (await agent.post('/appointments', { contact_id: cid, starts_at: new Date(Date.now() - 3 * H).toISOString(), type: 'in-person' })).json.id;
  await agent.patch(`/appointments/${past}`, { status: 'cancelled' });
  const comp = (await admin.get('/compliance')).json;
  const flagged = comp.appointments.find((a) => a.id === past);
  assert.ok(flagged, 'still listed');
  assert.match(flagged.compliance.label, /SOA missing \(cancelled after the start time\)/);
});

test('M1 rate limiter memory is bounded and IPv6 is grouped by /64', () => {
  const rl = new RateLimiter([{ windowMs: 60000, max: 2 }], { maxKeys: 100, keyFn: ipKey });
  for (let i = 0; i < 1000; i++) rl.hit(`10.0.${i >> 8}.${i & 255}`);
  assert.ok(rl.size <= 100);
  assert.equal(rl.hit('2001:db8:aa:bb:1::1'), true);
  assert.equal(rl.hit('2001:db8:aa:bb:ffff::2'), true);
  assert.equal(rl.hit('2001:db8:aa:bb:9:9:9:9'), false, 'same /64 shares the budget');
  assert.equal(rl.hit('2001:db8:aa:bc::1'), true, 'different /64');
  rl.prune(Date.now() + 120000);
  assert.equal(rl.size, 0, 'expired keys swept');
});

test('M2 lead intake refuses cross-site posts; header-less clients get consent held', async (t) => {
  const { s, post } = await setup(t);
  let r = await post(lead({ email: 'x1@example.com' }), { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  r = await post(lead({ email: 'x2@example.com' }), { headers: { origin: s.base, 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  r = await request(s.base, 'POST', '/api/leads', { json: { form_token: s.app.ctx.formTokens.issue(Date.now() - 60000).token, ...lead({ first_name: 'No', last_name: 'Origin', phone: '4045550311', email: 'noorigin@example.com', consent_texts: 'yes' }) }, headers: { 'x-forwarded-for': '198.51.100.80' } });
  assert.equal(r.status, 201);
  const c = s.db.prepare("SELECT id FROM contacts WHERE email = 'noorigin@example.com'").get();
  const rows = s.db.prepare('SELECT * FROM consents WHERE contact_id = ?').all(c.id);
  assert.ok(rows.every((x) => x.effective === 0 && /Origin/.test(x.review_reason)));
  await post(lead({ email: 'withref@example.com', phone: '' }), { headers: { referer: `${s.base}/contact/` } });
  const req = s.db.prepare("SELECT cr.origin, cr.referer FROM contact_requests cr JOIN contacts c ON c.id = cr.contact_id WHERE c.email = 'withref@example.com'").get();
  assert.equal(req.origin, s.base);
  assert.equal(req.referer, `${s.base}/contact/`);
});

test('M3 bulk reads are capped for agents and audited', async (t) => {
  const { s, admin, agent } = await setup(t);
  for (let i = 0; i < 120; i++) s.db.prepare("INSERT INTO contacts (first_name, last_name, created_at, updated_at) VALUES ('Bulk', ?, ?, ?)").run(`N${i}`, new Date().toISOString(), new Date().toISOString());
  let r = await agent.get('/contacts?per_page=500&q=Bulk');
  assert.equal(r.json.items.length, 100);
  r = await admin.get('/contacts?per_page=500&q=Bulk');
  assert.equal(r.json.items.length, 120);
  assert.equal((await agent.get('/contacts?archived=all')).status, 403);
  const row = s.db.prepare("SELECT * FROM audit_log WHERE action = 'list' AND entity = 'contacts' AND user_name = 'Agent'").get();
  assert.match(row.summary, /count=100; filters: q/);
  assert.doesNotMatch(row.summary, /Bulk/, 'search text itself is not logged');
  for (const p of ['/policies', '/soas', '/consents', '/compliance']) {
    assert.equal((await agent.get(p)).status, 200);
  }
  const entities = s.db.prepare("SELECT DISTINCT entity FROM audit_log WHERE action = 'list'").all().map((x) => x.entity);
  for (const e of ['contacts', 'policies', 'soas', 'consents', 'compliance']) assert.ok(entities.includes(e), e);
});

test('M4 call logs: 24-hour lock for agents, revisions, soft delete', async (t) => {
  const { s, admin, agent } = await setup(t);
  const cid = (await agent.post('/contacts', { first_name: 'Log', last_name: 'Book' })).json.id;
  const aid = (await agent.post(`/contacts/${cid}/activities`, { type: 'call', direction: 'out', recorded: false, body: 'first' })).json.id;
  assert.equal((await agent.patch(`/activities/${aid}`, { body: 'second' })).status, 200);
  s.db.prepare('UPDATE activities SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * H).toISOString(), aid);
  for (const body of [{ recorded: true }, { type: 'note' }, { direction: 'in' }, { occurred_at: new Date().toISOString() }]) {
    assert.equal((await agent.patch(`/activities/${aid}`, body)).status, 403, JSON.stringify(body));
  }
  assert.equal((await agent.patch(`/activities/${aid}`, { body: 'third' })).status, 200, 'text can still be clarified');
  assert.equal((await admin.patch(`/activities/${aid}`, { recorded: true })).status, 200, 'admin may correct');
  const revs = s.db.prepare('SELECT * FROM activity_revisions WHERE activity_id = ? ORDER BY id').all(aid);
  assert.deepEqual(revs.map((x) => JSON.parse(x.old_values)), [{ body: 'first' }, { body: 'second' }, { recorded: 0 }]);
  assert.equal((await agent.del(`/activities/${aid}`)).status, 200);
  assert.ok(s.db.prepare('SELECT deleted_at FROM activities WHERE id = ?').get(aid).deleted_at, 'soft-deleted, not removed');
  const agentView = (await agent.get(`/contacts/${cid}`)).json.activities;
  assert.ok(!agentView.some((a) => a.id === aid), 'hidden from agents');
  const adminView = (await admin.get(`/contacts/${cid}`)).json.activities.find((a) => a.id === aid);
  assert.ok(adminView.deleted_at && adminView.revisions.length === 4, 'admins see it with history');
});

test('M5 do-not-contact and text consent enforced server-side', async (t) => {
  const { s, admin, agent } = await setup(t);
  const cid = (await agent.post('/contacts', { first_name: 'No', last_name: 'Calls', phone: '4045550320' })).json.id;
  let r = await agent.post(`/contacts/${cid}/activities`, { type: 'text', direction: 'out', body: 'hi' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'no_text_consent');
  r = await agent.post(`/contacts/${cid}/activities`, { type: 'text', direction: 'out', body: 'hi', override_reason: 'Replying to their text' });
  assert.equal(r.status, 201);
  await agent.post(`/contacts/${cid}/dnc`, { do_not_contact: true, reason: 'asked' });
  r = await agent.post(`/contacts/${cid}/activities`, { type: 'call', direction: 'out' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'dnc');
  assert.equal(r.json.needs_override, true);
  assert.equal((await agent.post(`/contacts/${cid}/activities`, { type: 'call', direction: 'in', body: 'They called us' })).status, 201, 'inbound is fine');
  r = await agent.post(`/contacts/${cid}/activities`, { type: 'call', direction: 'out', override_reason: 'Returning their call' });
  assert.equal(r.status, 201);
  assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'dnc_override' AND entity_id = ?").get(cid));
  assert.ok(s.db.prepare("SELECT 1 FROM activities WHERE contact_id = ? AND body LIKE '%overridden%Returning their call%'").get(cid));
  assert.equal((await agent.post(`/contacts/${cid}/dnc`, { do_not_contact: false, reason: 'changed mind' })).status, 403, 'agents cannot remove DNC');
  assert.equal((await admin.post(`/contacts/${cid}/dnc`, { do_not_contact: false })).status, 400, 'reason required');
  assert.equal((await admin.post(`/contacts/${cid}/dnc`, { do_not_contact: false, reason: 'Asked to be contacted again' })).status, 200);
});

test('M6 public form cannot change staff data on a matched contact', async (t) => {
  const { s, admin, post } = await setup(t);
  await post(lead({ first_name: 'Ruth', last_name: 'Real', phone: '4045550330', email: 'ruth@example.com', topic: 'turning-65', preferred_contact: 'phone' }));
  const c = s.db.prepare("SELECT * FROM contacts WHERE email = 'ruth@example.com'").get();
  await post(lead({ first_name: 'Ruth', last_name: 'Real', phone: '4045550330', email: '', topic: 'other', preferred_contact: 'email' }));
  let after = s.db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id);
  assert.equal(after.topic, 'turning-65', 'topic kept');
  assert.equal(after.preferred_contact, 'phone', 'preference kept');

  // Different name on the same phone: separate contact, flagged, original untouched.
  s.db.prepare("UPDATE contacts SET stage = 'lost' WHERE id = ?").run(c.id);
  await post(lead({ first_name: 'Mallory', last_name: 'Other', phone: '4045550330', email: '' }));
  after = s.db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id);
  assert.equal(after.stage, 'lost', 'no stage change from a mismatched name');
  const hh = s.db.prepare("SELECT * FROM contacts WHERE first_name = 'Mallory'").get();
  assert.ok(hh && hh.id !== c.id);
  assert.equal(hh.related_contact_id, c.id);
  assert.match(hh.tags, /household/);
  assert.ok(s.db.prepare("SELECT 1 FROM tasks WHERE contact_id = ? AND title LIKE 'Possible household member%'").get(hh.id));
  const req = s.db.prepare('SELECT * FROM contact_requests WHERE contact_id = ?').get(hh.id);
  assert.equal(req.submitted_name, 'Mallory Other');
  assert.equal(req.match_type, 'household');

  // Accent/case-insensitive name match attaches to the right person.
  await post(lead({ first_name: 'RUTH', last_name: 'Réal', phone: '4045550330', email: '' }));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE last_name IN ('Real','Réal')").get().n, 1);

  // Archived: stays archived, review task instead.
  await admin.post(`/contacts/${c.id}/archive`);
  await post(lead({ first_name: 'Ruth', last_name: 'Real', phone: '4045550330', email: '' }));
  assert.ok(s.db.prepare('SELECT archived_at FROM contacts WHERE id = ?').get(c.id).archived_at, 'not unarchived');
  assert.ok(s.db.prepare("SELECT 1 FROM tasks WHERE contact_id = ? AND title = 'Archived contact sent a new request — review'").get(c.id));
});

test('M7 append-only tables reject deletes and edits', async (t) => {
  const { s, post } = await setup(t);
  await post(lead({ first_name: 'App', last_name: 'End', phone: '4045550340', email: 'append@example.com', consent_texts: 'yes' }));
  assert.throws(() => s.db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.throws(() => s.db.prepare('DELETE FROM consents').run(), /append-only/);
  assert.throws(() => s.db.prepare("UPDATE consents SET consent_text = 'x'").run(), /append-only/);
  assert.throws(() => s.db.prepare("UPDATE contact_requests SET topic = 'other'").run(), /append-only/);
  assert.throws(() => s.db.prepare('DELETE FROM contact_requests').run(), /append-only/);
  const cid = s.db.prepare("SELECT id FROM contacts WHERE email = 'append@example.com'").get().id;
  require('../server/services').recordConsent(s.db, { contact_id: cid, channel: 'text', granted: 0, phone: '4045550340', source: 'manual' });
  assert.throws(() => s.db.prepare('DELETE FROM suppressions').run(), /append-only/);
  s.db.prepare('UPDATE contact_requests SET reviewed_at = ?').run(new Date().toISOString()); // review fields allowed
});

test('L2/L4 and INFO items', async (t) => {
  const { s, admin, post, token } = await setup(t);
  assert.equal((await admin.get('/contacts?sort=constructor')).status, 400);
  assert.equal((await admin.get('/contacts?sort=__proto__')).status, 400);
  assert.equal((await admin.get('/export/constructor')).status, 404);

  const ft = await request(s.base, 'GET', '/api/form-token');
  assert.equal(ft.status, 200);
  assert.match(ft.json.token, /^\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(ft.headers.get('cache-control'), 'no-store');
  assert.equal(ft.headers.get('cross-origin-resource-policy'), 'same-origin');
  const before = s.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  let r = await post(lead({ email: 'fast@example.com', phone: '', form_token: token(500) }), { withToken: false });
  assert.equal(r.status, 201, 'bot gets fake success');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, before, 'nothing stored');
  r = await post(lead({ first_name: 'Forged', last_name: 'Token', email: 'forged@example.com', phone: '4045550350', consent_texts: 'yes', form_token: `${Date.now() - 60000}.${'A'.repeat(43)}` }), { withToken: false });
  assert.equal(r.status, 201, 'real people are never lost');
  const c = s.db.prepare("SELECT id FROM contacts WHERE email = 'forged@example.com'").get();
  assert.equal(s.db.prepare('SELECT verified FROM contact_requests WHERE contact_id = ?').get(c.id).verified, 0);
  assert.ok(s.db.prepare('SELECT * FROM consents WHERE contact_id = ?').all(c.id).every((x) => x.effective === 0));

  const api = await admin.get('/me');
  assert.equal(api.headers.get('cross-origin-resource-policy'), 'same-origin');
  const lines = [];
  const s2 = await startServer({ quiet: false, logSink: (l) => lines.push(l) });
  try {
    await createUser(s2.db, { email: 'log@example.com' });
    const c2 = await login(s2.base, 'log@example.com');
    await c2.get('/me');
  } finally { await s2.close(); }
  assert.ok(lines.some((l) => /"p":"\/crm\/api\/me".*"u":1/.test(l)), 'user id in CRM API logs');
});
