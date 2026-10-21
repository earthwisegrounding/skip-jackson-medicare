'use strict';
// Regression tests for the events adversarial review (C1, H1-H4, M1-M7, L1-L7).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createUser, request, login } = require('./helpers');
const { checkEvent, anonymizeOldRsvps, normalizeAddress } = require('../server/events');

const DAY = 864e5;
const at = (days, hourUtc = 18) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(hourUtc, 0, 0, 0); return d.toISOString(); };
const base = (over = {}) => ({
  title: 'Understanding Medicare', event_type: 'educational', starts_at: at(10), ends_at: at(10, 20), format: 'in_person',
  venue_name: 'Example Library', address: '1 Example St', city: 'Decatur', zip: '30030', summary: 'How Medicare works.',
  description: 'An overview of Parts A, B, C and D.', rsvp_enabled: 1, healthcare_setting: 'no', carrier_submitted: 0, ...over,
});
const mk = (over = {}) => base({ event_type: 'marketing', title: 'Plan options', carrier_submitted: 1, ...over });
const blockers = (e) => checkEvent(e).blockers.map((b) => b.id);

async function setup(t, overrides) {
  const s = await startServer(overrides);
  t.after(() => s.close());
  await createUser(s.db, { email: 'admin@example.com', name: 'Admin', role: 'admin' });
  await createUser(s.db, { email: 'agent@example.com', name: 'Agent', role: 'agent' });
  const admin = await login(s.base, 'admin@example.com');
  const agent = await login(s.base, 'agent@example.com');
  const tok = (age = 60000) => s.app.ctx.formTokens.issue(Date.now() - age).token;
  const rsvpRaw = (slug, body, headers = {}, { token = true } = {}) => request(s.base, 'POST', `/events/${slug}/rsvp`, {
    form: { ...(token ? { form_token: tok() } : {}), ...body }, headers: { origin: s.base, 'x-forwarded-for': '198.51.100.70', ...headers },
  });
  let day = 10; // each event on its own day unless a test says otherwise (avoids accidental same-venue pairing)
  const create = async (over) => { day += 1; const r = await admin.post('/events', base({ starts_at: at(day), ends_at: at(day, 20), ...over })); assert.equal(r.status, 201, r.body); return r.json.id; };
  const publish = async (over) => { const id = await create(over); const p = await admin.post(`/events/${id}/publish`); assert.equal(p.status, 200, p.body); return id; };
  const get = async (id) => (await admin.get(`/events/${id}`)).json.event;
  return { s, admin, agent, tok, rsvpRaw, create, publish, get };
}

test('H3 hardened wording lint', () => {
  for (const evasion of ['frее seminar' /* Cyrillic е */, 'fr​ee seminar', 'f r e e seminar', 'F.R.E.E seminar', 'ＦＲＥＥ seminar', 'Fr-ee seminar']) {
    assert.ok(blockers(base({ title: evasion })).includes('wording'), JSON.stringify(evasion));
  }
  assert.ok(!blockers(base({ description: 'Celebrating freedom and independence.' })).includes('wording'), '"freedom" is fine');
  for (const term of ['freebie', 'no charge', 'no-cost', 'at no cost', 'zero premium', '$0.00 plans', 'No. 1 agent', 'number one', 'highest rated',
    'endorsed by Medicare', 'CMS approved', 'federal', 'state-sponsored', 'Social Security Administration', 'Medicare Help Center', 'Medicare hotline', 'the bеst' /* Cyrillic */]) {
    assert.ok(blockers(base({ summary: term })).includes('wording'), term);
  }
  for (const meal of ['Pizza after', 'BBQ', 'barbecue', 'potluck', 'hot food served', 'sandwiches', 'supper', 'l u n c h']) {
    assert.ok(blockers(mk({ refreshments: meal })).includes('meals'), meal);
  }
  assert.ok(!blockers(mk({ refreshments: 'Light refreshments, snacks, coffee and water' })).includes('meals'));
  for (const ok of ['When the Annual Enrollment Period happens', 'Open Enrollment explained', 'Your enrollment periods']) {
    assert.ok(!blockers(base({ summary: ok })).includes('edu_sales'), ok);
  }
  for (const sales of ['Enroll today', 'Bring your applications', 'How to apply', 'Should you switch plans?', 'Get a quote', 'Enrollment help available']) {
    assert.ok(blockers(base({ summary: sales })).includes('edu_sales'), sales);
  }
  for (const c of ['Anthem', 'Blue Cross', 'BlueCross BlueShield', 'Cigna', 'Kaiser', 'CareSource', 'Alignment Health', 'Amerigroup', 'Peach State', 'Clover Health', 'AARP', 'UHC', 'Ambetter', 'H u m a n a', 'Aet.na']) {
    assert.ok(blockers(base({ description: `About ${c}` })).includes('edu_sales'), c);
  }
});

test('H2 every public field is linted', () => {
  for (const field of ['venue_name', 'address', 'city', 'accessibility_notes', 'cancel_reason', 'online_join_info', 'refreshments']) {
    assert.ok(blockers(base({ [field]: 'The best place' })).includes('wording'), field);
  }
  assert.ok(blockers(base({ venue_name: 'Humana Neighborhood Center' })).includes('edu_sales'), 'carrier check covers the venue too');
});

test('M4 gifts and raffles', () => {
  assert.ok(blockers(base({ description: 'Door prize drawing at the end.' })).includes('gifts_ack'));
  assert.ok(!blockers(base({ description: 'Door prize drawing at the end.', gifts_ack: 1 })).length);
  assert.ok(blockers(base({ description: 'Raffle for a $50 prize.', gifts_ack: 1 })).includes('gift_cash'));
  assert.ok(!blockers(base({ description: 'Raffle for a $10 tote bag prize.', gifts_ack: 1 })).includes('gift_cash'));
  for (const c of ['a cash prize', 'a Visa gift card giveaway', 'prepaid card raffle', 'a $25 gift card raffle']) {
    assert.ok(blockers(base({ description: c, gifts_ack: 1 })).includes('gift_cash'), c);
  }
});

test('M6/L2 address normalization and educational-in-patient-area warning', () => {
  assert.equal(normalizeAddress('100 Example Street, Suite 2'), normalizeAddress('100 example st. ste 2'));
  assert.equal(normalizeAddress('5 North Main Road'), normalizeAddress('5 N. Main Rd'));
  assert.ok(checkEvent(base({ healthcare_setting: 'patient_care_area' })).warnings.some((w) => w.id === 'edu_setting'));
});

test('events review: server behaviour', async (t) => {
  const { s, admin, agent, tok, rsvpRaw, create, publish, get } = await setup(t);

  await t.test('C1 unpublish hides the event; agents cannot edit; cancel re-lints before going public', async () => {
    const id = await publish({ title: 'Visibility check' });
    const e = await get(id);
    assert.equal((await request(s.base, 'GET', `/events/${e.slug}/`)).status, 200);
    assert.equal((await admin.post(`/events/${id}/unpublish`)).status, 200);
    assert.equal((await request(s.base, 'GET', `/events/${e.slug}/`)).status, 404, 'unpublished = not public');
    assert.equal((await agent.patch(`/events/${id}`, { title: 'FREE LUNCH best ever' })).status, 403, 'agents cannot edit once published');
    // Even if bad text gets into the stored event, cancelling a draft never makes it public...
    s.db.prepare("UPDATE events SET title = 'FREE LUNCH best ever' WHERE id = ?").run(id);
    assert.equal((await admin.post(`/events/${id}/cancel`, { reason: 'Changed plans' })).status, 200);
    assert.equal((await request(s.base, 'GET', `/events/${e.slug}/`)).status, 404);
    assert.doesNotMatch((await request(s.base, 'GET', '/events/')).body, /FREE LUNCH/);
    // ...and cancelling a published event with bad stored text or a bad reason is refused.
    const id2 = await publish({ title: 'Cancel lint check' });
    s.db.prepare("UPDATE events SET description = 'The best seminar' WHERE id = ?").run(id2);
    let r = await admin.post(`/events/${id2}/cancel`, { reason: 'Weather' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'compliance');
    s.db.prepare("UPDATE events SET description = 'Fine text' WHERE id = ?").run(id2);
    r = await admin.post(`/events/${id2}/cancel`, { reason: 'Rescheduled to a free day' });
    assert.equal(r.status, 400, 'the cancel reason is linted too');
    r = await admin.post(`/events/${id2}/cancel`, { reason: 'The room flooded' });
    assert.equal(r.status, 200);
    assert.match((await request(s.base, 'GET', '/events/')).body, /The room flooded/);
  });

  await t.test('H2 admin edits of published events are re-linted on every public field', async () => {
    const id = await publish({ title: 'Edit lint check' });
    const r = await admin.patch(`/events/${id}`, { accessibility_notes: 'Official Medicare accessible venue' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'compliance');
  });

  let online;
  await t.test('H1 online join link without giving contact details', async () => {
    const id = await publish({ title: 'Online basics', format: 'online', venue_name: null, address: null, city: null, rsvp_enabled: 0, online_join_info: 'https://example.com/JOIN-123' });
    online = await get(id);
    const d = await request(s.base, 'GET', `/events/${online.slug}/`);
    assert.doesNotMatch(d.body, /JOIN-123/);
    assert.match(d.body, /You don’t need to sign up or give any contact details to join/);
    assert.match(d.body, /action="\/events\/[^"]+\/join"/);
    const j = await request(s.base, 'POST', `/events/${online.slug}/join`, { form: {}, headers: { origin: s.base } });
    assert.equal(j.status, 200);
    assert.match(j.body, /JOIN-123/);
    assert.equal(j.headers.get('cache-control'), 'no-store');
    assert.match(j.headers.get('x-robots-tag'), /noindex/);
    assert.equal((await request(s.base, 'GET', `/events/${online.slug}/join`)).status, 405);
    assert.equal((await request(s.base, 'POST', `/events/${online.slug}/join`, { form: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  });

  await t.test('H4/L5 RSVP integrity: unverified, dedupe, per-IP cap, PRG confirmation, closed after start', async () => {
    const id = await publish({ title: 'Seats check', capacity: 4 });
    const e = await get(id);
    const n = (sql = '') => s.db.prepare(`SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ? ${sql}`).get(id).n;
    // No token and no Origin: stored, unverified, doesn't use seats.
    let r = await rsvpRaw(e.slug, { first_name: 'No', last_name: 'Token', email: 'nt@example.com', guests: '3' }, { 'x-forwarded-for': '198.51.100.71' }, { token: false });
    assert.equal(r.status, 303);
    r = await request(s.base, 'POST', `/events/${e.slug}/rsvp`, { form: { form_token: tok(), first_name: 'No', last_name: 'Origin', email: 'no@example.com', guests: '3' }, headers: { 'x-forwarded-for': '198.51.100.72' } });
    assert.equal(r.status, 303);
    assert.equal(n('AND verified = 0'), 2);
    // Verified: 4 seats still available.
    r = await rsvpRaw(e.slug, { first_name: 'Real', last_name: 'Person', email: 'real@example.com', guests: '1' }, { 'x-forwarded-for': '198.51.100.73' });
    assert.equal(r.status, 303);
    const loc = r.headers.get('location');
    assert.match(loc, /\/confirmed\?t=/);
    assert.doesNotMatch(loc, /rsvp_id|\d{1,6}$/);
    const c1 = await request(s.base, 'GET', loc);
    assert.equal(c1.status, 200);
    assert.match(c1.body, /You’re signed up/);
    assert.equal((await request(s.base, 'GET', loc)).status, 200, 'refresh works without re-posting');
    assert.equal((await request(s.base, 'GET', `/events/${e.slug}/confirmed?t=wrong`)).status, 404);
    // Same email again updates instead of duplicating.
    r = await rsvpRaw(e.slug, { first_name: 'Real', last_name: 'Person', email: 'REAL@example.com', guests: '2' }, { 'x-forwarded-for': '198.51.100.73' });
    assert.equal(r.status, 303);
    assert.equal(n("AND email = 'real@example.com'"), 1);
    assert.equal(s.db.prepare("SELECT guests FROM event_rsvps WHERE email = 'real@example.com'").get().guests, 2);
    // 3 verified seats taken; capacity 4: a party of 2 doesn't fit.
    r = await rsvpRaw(e.slug, { first_name: 'Two', last_name: 'More', email: 'two@example.com', guests: '1' }, { 'x-forwarded-for': '198.51.100.74' });
    assert.equal(r.status, 409);
    // Expired confirmation link.
    s.db.prepare("UPDATE event_rsvps SET confirm_expires_at = ? WHERE email = 'real@example.com'").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await request(s.base, 'GET', `/events/${e.slug}/confirmed?t=x`)).status, 404);
    // JSON never reveals an id.
    const id2 = await publish({ title: 'JSON check' });
    const e2 = await get(id2);
    const j = await request(s.base, 'POST', `/events/${e2.slug}/rsvp`, { json: { form_token: tok(), first_name: 'J', last_name: 'S', email: 'js@example.com' }, headers: { origin: s.base, 'x-forwarded-for': '198.51.100.75' } });
    assert.equal(j.status, 201);
    assert.deepEqual(j.json, { ok: true });
    // Per-IP cap: 6 seats per event.
    for (const [i, g] of [[1, 5]]) assert.equal((await rsvpRaw(e2.slug, { first_name: 'Big', last_name: `G${i}`, email: `g${i}@example.com`, guests: String(g) }, { 'x-forwarded-for': '198.51.100.76' })).status, 303);
    r = await rsvpRaw(e2.slug, { first_name: 'One', last_name: 'More', email: 'onemore@example.com' }, { 'x-forwarded-for': '198.51.100.76' });
    assert.equal(r.status, 429);
    assert.match(r.body, /For groups larger than 6/);
    // Closed once the event has started.
    s.db.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), id2);
    r = await rsvpRaw(e2.slug, { first_name: 'Late', last_name: 'Comer', email: 'late2@example.com' }, { 'x-forwarded-for': '198.51.100.77' });
    assert.equal(r.status, 409);
    assert.match((await request(s.base, 'GET', `/events/${e2.slug}/`)).body, /Sign-up has closed/);
  });

  await t.test('M1 replacement patterns in user text are rendered literally', async () => {
    const id = await publish({ title: "Price $1 $& $` $' talk", summary: "Summary $1 $& $` $' end", event_type: 'marketing', carrier_submitted: 1 });
    const e = await get(id);
    for (const p of ['/events/', `/events/${e.slug}/`, '/']) {
      const r = await request(s.base, 'GET', p);
      assert.ok(r.body.includes("Price $1 $&amp; $` $&#39; talk") || p === '/', p);
      assert.doesNotMatch(r.body, /<!-- EVENTS:(LIST|HOME|HEAD)/, `${p}: injection markers replaced`);
    }
  });

  await t.test('M2 .ics has no bare CR, control or zero-width characters', async () => {
    const id = await publish({ title: 'ICS check' });
    s.db.prepare("UPDATE events SET summary = ? WHERE id = ?").run('Line one\rline two\u0001​ end', id);
    const e = await get(id);
    const r = await request(s.base, 'GET', `/events/${e.slug}/calendar.ics`);
    assert.doesNotMatch(r.body.replace(/\r\n/g, ''), /[\r\u0001​]/);
    assert.doesNotMatch(r.body, /^URL:/m, 'no absolute URL without PUBLIC_URL');
  });

  await t.test('M3 accommodation statement on the list, home section and detail page', async () => {
    const statement = 'For accommodation of persons with special needs at events, call (404) 354-7597 (TTY 711).';
    assert.ok((await request(s.base, 'GET', '/events/')).body.includes(statement));
    assert.ok((await request(s.base, 'GET', '/')).body.includes(statement));
    assert.match((await request(s.base, 'GET', `/events/${online.slug}/`)).body, /For accommodations, call \(404\) 354-7597 \(TTY 711\)/);
  });

  await t.test('M6 paired events: normalized venue, acknowledgement, notice on the educational page', async () => {
    const edu = await create({ title: 'Morning Medicare basics', starts_at: at(40, 14), ends_at: at(40, 15), address: '100 Example Street, Suite 2', city: 'Decatur' });
    const sales = await create({ title: 'Afternoon plan options', event_type: 'marketing', carrier_submitted: 1, starts_at: at(40, 16), ends_at: at(40, 17), address: '100 example st. ste 2', city: 'DECATUR' });
    assert.equal((await admin.post(`/events/${edu}/publish`)).status, 400, 'needs the hand-off acknowledgement');
    await admin.patch(`/events/${edu}`, { pairing_ack: true });
    await admin.patch(`/events/${sales}`, { pairing_ack: true });
    assert.equal((await admin.post(`/events/${edu}/publish`)).status, 200);
    assert.equal((await admin.post(`/events/${sales}/publish`)).status, 200);
    const page = await request(s.base, 'GET', `/events/${(await get(edu)).slug}/`);
    assert.match(page.body, /An optional information and enrollment session follows at \d{1,2}:00 (AM|PM) Eastern Time\. You’re welcome to leave before it begins\./);
  });

  await t.test('L4 home section never shows cancelled events', async () => {
    const r = await request(s.base, 'GET', '/');
    assert.doesNotMatch(r.body, /The room flooded|event-cancelled/);
  });

  await t.test('L7 only admins mark RSVPs cancelled', async () => {
    const row = s.db.prepare("SELECT id FROM event_rsvps WHERE status = 'going' LIMIT 1").get();
    assert.equal((await agent.post(`/event-rsvps/${row.id}/cancel`)).status, 403);
    assert.equal((await admin.post(`/event-rsvps/${row.id}/cancel`)).status, 200);
  });

  await t.test('M7 event-only RSVPs are anonymized 90 days after the event', async () => {
    const id = await publish({ title: 'Old event' });
    s.db.prepare('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?').run(at(-100), at(-100, 20), id);
    const now = new Date().toISOString();
    s.db.prepare("INSERT INTO event_rsvps (event_id, first_name, last_name, email, guests, contact_permission, created_at) VALUES (?, 'Keep', 'Private', 'old@example.com', 2, 0, ?)").run(id, now);
    s.db.prepare("INSERT INTO event_rsvps (event_id, first_name, last_name, email, guests, contact_permission, created_at) VALUES (?, 'Lead', 'Person', 'lead@example.com', 0, 1, ?)").run(id, now);
    assert.ok(anonymizeOldRsvps(s.db) >= 1);
    const rows = s.db.prepare('SELECT * FROM event_rsvps WHERE event_id = ? ORDER BY id').all(id);
    assert.equal(rows[0].email, null);
    assert.equal(rows[0].first_name, 'Removed');
    assert.equal(rows[0].guests, 2, 'counts kept');
    assert.equal(rows[1].email, 'lead@example.com', 'people who asked to be contacted are kept');
  });

  await t.test('L1 absolute URLs only from PUBLIC_URL, never the Host header', async () => {
    const e = await get((await publish({ title: 'Host check' })));
    const r = await request(s.base, 'GET', `/events/${e.slug}/`, { headers: { host: 'evil.example' } });
    assert.doesNotMatch(r.body, /evil\.example/);
    assert.match(r.body, /"url":"\/events\//);
  });
});

test('L1 PUBLIC_URL makes links absolute', async (t) => {
  const { s, publish, get } = await setup(t, { publicUrl: 'https://skip.example' });
  const e = await get(await publish({ title: 'Absolute check' }));
  assert.match((await request(s.base, 'GET', `/events/${e.slug}/`)).body, /"url":"https:\/\/skip\.example\/events\//);
  assert.match((await request(s.base, 'GET', `/events/${e.slug}/calendar.ics`)).body, /\r\nURL:https:\/\/skip\.example\/events\//);
});
