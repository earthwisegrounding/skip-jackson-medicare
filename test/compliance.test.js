'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { soaCompliance, permissionExpiresAt } = require('../server/compliance');
const { csvCell, toCsv } = require('../server/csv');
const { addBusinessDays, zonedParts, turning65FromDob, aepStatus } = require('../server/time');
const { startServer, createUser, login, request, lead } = require('./helpers');

const H = 3600e3;
const at = (base, deltaMs) => new Date(base + deltaMs).toISOString();

test('SOA timing rule (CMS-4212-F: documented before the appointment; no 48-hour wait)', async (t) => {
  const start = Date.parse('2026-11-10T15:00:00Z');
  const appt = (extra = {}) => ({ starts_at: at(start, 0), status: 'scheduled', type: 'phone', ...extra });

  await t.test('missing SOA', () => {
    const r = soaCompliance(appt(), null);
    assert.equal(r.code, 'missing');
    assert.equal(r.label, 'SOA missing');
    assert.equal(r.level, 'danger');
  });

  await t.test('signed days before is OK', () => {
    assert.equal(soaCompliance(appt(), { signed_at: at(start, -72 * H), signature_method: 'electronic' }).label, 'OK');
  });

  await t.test('signed the same day, before the start, is OK (no 48-hour rule)', () => {
    assert.equal(soaCompliance(appt(), { signed_at: at(start, -1 * H), signature_method: 'electronic' }).label, 'OK');
    assert.equal(soaCompliance(appt(), { signed_at: at(start, -47 * H), signature_method: 'paper' }).label, 'OK');
    assert.equal(soaCompliance(appt(), { signed_at: at(start, 0), signature_method: 'paper' }).label, 'OK', 'exactly at start counts as prior');
  });

  await t.test('recorded after start is a warning', () => {
    const r = soaCompliance(appt(), { signed_at: at(start, 10 * 60e3), signature_method: 'electronic' });
    assert.equal(r.label, 'SOA recorded after appointment start');
    assert.equal(r.level, 'warn');
  });

  await t.test('in-person appointments need a written SOA', () => {
    const r = soaCompliance(appt({ type: 'in-person' }), { signed_at: at(start, -24 * H), signature_method: 'verbal_recorded' });
    assert.equal(r.label, 'In-person appointment needs a written SOA');
    assert.equal(r.level, 'warn');
    assert.equal(soaCompliance(appt({ type: 'in-person' }), { signed_at: at(start, -24 * H), signature_method: 'paper' }).label, 'OK');
    assert.equal(soaCompliance(appt({ type: 'phone' }), { signed_at: at(start, -24 * H), signature_method: 'verbal_recorded' }).label, 'OK', 'verbal is fine for phone');
  });

  await t.test('SOA older than 12 months does not cover the appointment', () => {
    const r = soaCompliance(appt(), { signed_at: '2025-10-01T12:00:00Z', signature_method: 'electronic' });
    assert.equal(r.code, 'expired');
    assert.equal(permissionExpiresAt('2026-01-15T12:00:00.000Z'), '2027-01-15T12:00:00.000Z');
  });

  await t.test('cancelled appointments are not applicable', () => {
    assert.equal(soaCompliance(appt({ status: 'cancelled' }), null).code, 'not_applicable');
  });

  await t.test('API computes compliance per appointment and rejects future signatures', async () => {
    const s = await startServer();
    try {
      await createUser(s.db, { email: 'a@example.com', role: 'agent' });
      const c = await login(s.base, 'a@example.com');
      const contact = (await c.post('/contacts', { first_name: 'Soa', last_name: 'Person' })).json.id;
      const inPerson = (await c.post('/appointments', { contact_id: contact, starts_at: new Date(Date.now() + 5 * H).toISOString(), type: 'in-person' })).json.id;
      const phone = (await c.post('/appointments', { contact_id: contact, starts_at: new Date(Date.now() + 3 * 864e5).toISOString(), type: 'phone' })).json.id;
      let list = (await c.get(`/appointments?contact_id=${contact}`)).json.items;
      assert.ok(list.every((a) => a.compliance.label === 'SOA missing'));

      let r = await c.post('/soas', { contact_id: contact, appointment_id: inPerson, products: ['medicare_advantage'], signature_method: 'verbal_recorded', signed_at: new Date().toISOString(), initiated_by: 'beneficiary' });
      assert.equal(r.status, 201);
      r = await c.post('/soas', { contact_id: contact, appointment_id: phone, products: ['part_d', 'medigap'], signature_method: 'verbal_recorded', signed_at: new Date().toISOString(), initiated_by: 'agent' });
      assert.equal(r.status, 201);
      list = (await c.get(`/appointments?contact_id=${contact}`)).json.items;
      assert.equal(list.find((a) => a.id === inPerson).compliance.label, 'In-person appointment needs a written SOA');
      assert.equal(list.find((a) => a.id === phone).compliance.label, 'OK');

      r = await c.post('/soas', { contact_id: contact, products: ['part_d'], signature_method: 'paper', signed_at: new Date(Date.now() + 864e5).toISOString(), initiated_by: 'agent' });
      assert.equal(r.status, 400);
      assert.ok(r.json.errors.signed_at);
      r = await c.post('/soas', { contact_id: contact, products: [], signature_method: 'paper', signed_at: new Date().toISOString(), initiated_by: 'agent' });
      assert.equal(r.status, 400);
      assert.ok(r.json.errors.products);
      r = await c.post('/soas', { contact_id: contact, products: ['timeshare'], signature_method: 'paper', signed_at: new Date().toISOString(), initiated_by: 'agent' });
      assert.equal(r.status, 400);

      const detail = (await c.get(`/contacts/${contact}`)).json;
      assert.equal(detail.soas.length, 2);
      assert.ok(detail.soas[0].valid_until);
      const comp = (await c.get('/compliance')).json;
      assert.ok(comp.appointments.some((a) => a.id === inPerson));
      assert.equal(comp.exports, null, 'agents do not see the export log');
    } finally {
      await s.close();
    }
  });
});

test('CSV injection escaping', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('\tTAB'), "'\tTAB");
  assert.equal(csvCell('\rCR'), `"'\rCR"`);
  assert.equal(csvCell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(42), '42');
  const out = toCsv([{ key: 'a', label: 'A' }, { key: 'b', label: '=B' }], [{ a: '=x', b: 'ok' }]);
  assert.equal(out, "﻿A,'=B\r\n'=x,ok\r\n");
});

test('date helpers (Georgia time)', () => {
  // Friday 3 PM Eastern -> Monday 3 PM Eastern
  const fri = new Date('2026-10-23T19:00:00Z');
  const next = addBusinessDays(fri, 1);
  const p = zonedParts(next);
  assert.equal(p.wd, 1);
  assert.equal(p.h, 15);
  // Across the DST change (Nov 1, 2026): Friday Oct 30 3 PM EDT -> Monday Nov 2 3 PM EST
  const p2 = zonedParts(addBusinessDays(new Date('2026-10-30T19:00:00Z'), 1));
  assert.deepEqual([p2.m, p2.d, p2.h], [11, 2, 15]);
  assert.equal(turning65FromDob('1961-03-15'), '2026-03');
  assert.equal(aepStatus(new Date('2026-10-21T15:00:00Z')).days_left, 47);
  assert.equal(aepStatus(new Date('2026-12-07T15:00:00Z')).days_left, 0);
  assert.equal(aepStatus(new Date('2026-12-08T15:00:00Z')).active, false);
});

test('consent log, opt-out, DNC and 12-month contact permission', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await createUser(s.db, { email: 'admin@example.com', role: 'admin' });
  const c = await login(s.base, 'admin@example.com');
  const id = (await c.post('/contacts', { first_name: 'Opt', last_name: 'Out', phone: '4045550150' })).json.id;

  await t.test('grant then opt-out by any means; history is append-only', async () => {
    let r = await c.post(`/contacts/${id}/consents`, { channels: ['call', 'text'], granted: true, source: 'verbal', consent_text: 'OK to call and text about plans.' });
    assert.equal(r.status, 201);
    assert.equal(r.json.state.text.granted, true);
    r = await c.post(`/contacts/${id}/consents`, { channels: ['text'], granted: false, source: 'verbal', notes: 'Opt-out: Asked on a call.' });
    assert.equal(r.status, 201);
    assert.equal(r.json.state.text.granted, false, 'revocation effective immediately');
    assert.equal(r.json.state.call.granted, true);
    r = await c.post(`/contacts/${id}/consents`, { channels: ['text'], granted: true, source: 'verbal' });
    assert.equal(r.status, 400, 'grant needs the wording');
    assert.equal((await c.patch('/consents/1', { granted: true })).status, 404, 'no edit endpoint');
    assert.equal((await c.del('/consents/1')).status, 404, 'no delete endpoint');
  });

  await t.test('marking DNC revokes every channel and blocks new consent', async () => {
    let r = await c.post(`/contacts/${id}/dnc`, { do_not_contact: true, reason: 'Asked not to be contacted' });
    assert.equal(r.status, 200);
    const detail = (await c.get(`/contacts/${id}`)).json;
    for (const ch of ['call', 'text', 'email', 'automated']) assert.equal(detail.consent_state[ch].granted, false, ch);
    r = await c.post(`/contacts/${id}/consents`, { channels: ['call'], granted: true, source: 'verbal', consent_text: 'x' });
    assert.equal(r.status, 409);
  });

  await t.test('web request permission expires after 12 months; dashboard lists unenrolled expired leads', async () => {
    const lid = (await c.post('/contacts', { first_name: 'Old', last_name: 'Lead', email: 'old.lead@example.com' })).json.id;
    const old = new Date(Date.now() - 400 * 864e5).toISOString();
    s.db.prepare('INSERT INTO contact_requests (contact_id, requested_at, topic) VALUES (?, ?, ?)').run(lid, old, 'other');
    const detail = (await c.get(`/contacts/${lid}`)).json;
    assert.equal(detail.contact_permission.expired, true);
    const dash = (await c.get('/dashboard')).json;
    assert.ok(dash.permission_expired.some((x) => x.id === lid));
    assert.ok(s.db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(lid), 'nothing deleted');
    await c.post('/policies', { contact_id: lid, carrier: 'Aetna', plan_type: 'MAPD', status: 'active' });
    const dash2 = (await c.get('/dashboard')).json;
    assert.ok(!dash2.permission_expired.some((x) => x.id === lid), 'enrolled people drop off the list');
  });
});

test('QA: Georgia-time UI helpers, DST, turning 65 on the 1st, quick-add duplicate check', async (t) => {
  const TZ = require('../crm/tz.js');
  // An appointment entered as 1:00-2:30 AM on Nov 1 2026 (DST ends at 2 AM) keeps its wall-clock times.
  const start = TZ.fromInput('2026-11-01T00:30');
  const end = TZ.fromInput('2026-11-01T03:00');
  assert.equal(TZ.toInput(start), '2026-11-01T00:30');
  assert.equal(TZ.toInput(end), '2026-11-01T03:00');
  assert.equal((Date.parse(end) - Date.parse(start)) / 60000, 210, '2.5 h on the clock is 3.5 h elapsed across fall-back');
  // An hour-long default end added to a start keeps exactly 60 minutes.
  const s2 = TZ.fromInput('2026-10-31T23:30');
  assert.equal(TZ.toInput(new Date(Date.parse(s2) + 3600e3).toISOString()), '2026-11-01T00:30');
  // Browser zone doesn't matter: Georgia wall-clock is used.
  assert.equal(TZ.toInput('2026-07-04T16:00:00.000Z'), '2026-07-04T12:00');
  assert.equal(TZ.dayKey('2026-07-05T02:00:00.000Z'), '2026-07-04');

  const { turning65FromDob } = require('../server/time');
  assert.equal(turning65FromDob('1961-03-01'), '2026-02', 'born on the 1st -> previous month');
  assert.equal(turning65FromDob('1961-01-01'), '2025-12');
  assert.equal(turning65FromDob('1961-03-02'), '2026-03');

  const s = await startServer();
  t.after(() => s.close());
  await createUser(s.db, { email: 'q@example.com', role: 'admin' });
  const c = await login(s.base, 'q@example.com');
  const a = await c.post('/contacts', { first_name: 'José', last_name: "O'Brien", phone: '4045550360', zip: '30303-1234', date_of_birth: '1961-03-01' });
  assert.equal(a.status, 201);
  const dup = await c.post('/contacts', { first_name: 'Other', last_name: 'Person', phone: '(404) 555-0360' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.contact_id, a.json.id);
  const detail = (await c.get(`/contacts/${a.json.id}`)).json.contact;
  assert.equal(detail.zip, '30303');
  assert.equal(detail.turning_65, '2026-02');
  for (const q of ['Jose', 'jose obrien', "o'brien", 'OBRIEN']) {
    assert.equal((await c.get(`/contacts?q=${encodeURIComponent(q)}`)).json.total, 1, q);
  }
  // Appointment PATCH validates against the stored end time.
  const appt = (await c.post('/appointments', { contact_id: a.json.id, starts_at: '2026-12-01T15:00:00Z', ends_at: '2026-12-01T16:00:00Z', type: 'phone' })).json.id;
  assert.equal((await c.patch(`/appointments/${appt}`, { starts_at: '2026-12-01T17:00:00Z' })).status, 400);
  // Keep-alive extends the idle timer.
  const { sha256 } = require('../server/auth');
  const hash = sha256(c.cookie.split('=')[1]);
  s.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 20 * 60e3).toISOString(), hash);
  assert.equal((await c.post('/keepalive')).status, 200);
  assert.ok(Date.now() - Date.parse(s.db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hash).last_seen_at) < 5000);
  const meta = (await c.get('/meta')).json;
  assert.equal(meta.timezone, 'America/New_York');
});

test('QA: callbacks, typo-friendly rate limit, archived tasks, deactivated assignee', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await createUser(s.db, { email: 'boss@example.com', name: 'Boss', role: 'admin' });
  const gone = await createUser(s.db, { email: 'old@example.com', name: 'Old', role: 'agent' });
  const c = await login(s.base, 'boss@example.com');
  const tok = () => s.app.ctx.formTokens.issue(Date.now() - 60000).token;
  const post = (body, ip) => request(s.base, 'POST', '/api/leads', { json: { form_token: tok(), ...body }, headers: { origin: s.base, 'x-forwarded-for': ip } });

  // Typos don't eat the submission budget.
  for (let i = 0; i < 8; i++) assert.equal((await post(lead({ email: 'bad', phone: '' }), '198.51.100.90')).status, 400);
  assert.equal((await post(lead({ email: 'typo.fixed@example.com', phone: '' }), '198.51.100.90')).status, 201);

  // Re-submissions reuse the open call-back task; an outbound call completes it.
  await post(lead({ first_name: 'Cal', last_name: 'Back', phone: '4045550370', email: '' }), '198.51.100.91');
  await post(lead({ first_name: 'Cal', last_name: 'Back', phone: '4045550370', email: '' }), '198.51.100.91');
  const cid = s.db.prepare("SELECT id FROM contacts WHERE phone = '4045550370'").get().id;
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE contact_id = ? AND kind = 'callback'").get(cid).n, 1);
  const r = await c.post(`/contacts/${cid}/activities`, { type: 'call', direction: 'out', recorded: true, body: 'Called back' });
  assert.equal(r.json.completed_tasks, 1);
  assert.ok(s.db.prepare("SELECT done_at FROM tasks WHERE contact_id = ? AND kind = 'callback'").get(cid).done_at);

  // DNC closes open call-backs.
  await post(lead({ first_name: 'No', last_name: 'More', phone: '4045550371', email: '' }), '198.51.100.92');
  const nid = s.db.prepare("SELECT id FROM contacts WHERE phone = '4045550371'").get().id;
  await c.post(`/contacts/${nid}/dnc`, { do_not_contact: true, reason: 'asked' });
  assert.ok(s.db.prepare("SELECT done_at FROM tasks WHERE contact_id = ? AND kind = 'callback'").get(nid).done_at);

  // Archived contacts' tasks disappear from task lists.
  await post(lead({ first_name: 'Arch', last_name: 'Ived', phone: '4045550372', email: '' }), '198.51.100.93');
  const aid = s.db.prepare("SELECT id FROM contacts WHERE phone = '4045550372'").get().id;
  await c.post(`/contacts/${aid}/archive`);
  const tasks = (await c.get('/tasks?scope=all')).json.items;
  assert.ok(!tasks.some((x) => x.contact_id === aid));

  // A lead for a contact assigned to a deactivated user goes to the default (first active admin).
  s.db.prepare('UPDATE contacts SET assigned_user_id = ? WHERE id = ?').run(gone, cid);
  s.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone);
  s.db.prepare("UPDATE tasks SET done_at = ? WHERE contact_id = ?").run(new Date().toISOString(), cid);
  await post(lead({ first_name: 'Cal', last_name: 'Back', phone: '4045550370', email: '' }), '198.51.100.94');
  const t2 = s.db.prepare("SELECT assigned_user_id FROM tasks WHERE contact_id = ? AND done_at IS NULL").get(cid);
  assert.equal(t2.assigned_user_id, c.user.id);
});
