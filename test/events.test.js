'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createUser, request, login } = require('./helpers');
const { checkEvent } = require('../server/events');

const DAY = 864e5;
const at = (days, hourUtc = 18) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(hourUtc, 0, 0, 0); return d.toISOString(); };

const base = (over = {}) => ({
  title: 'Understanding Medicare', event_type: 'educational', starts_at: at(10), ends_at: at(10, 20), format: 'in_person',
  venue_name: 'Example Library', address: '1 Example St', city: 'Decatur', zip: '30030', summary: 'How Medicare works.',
  description: 'An overview of Parts A, B, C and D.', rsvp_enabled: 1, healthcare_setting: 'no', carrier_submitted: 0, ...over,
});
const failing = (e) => checkEvent(e).blockers.map((b) => b.id);

test('event publish rules', () => {
  assert.deepEqual(failing(base()), [], 'a clean educational event passes');
  const mk = base({ event_type: 'marketing', title: 'Plan options for 2027' });
  assert.ok(failing(mk).includes('carrier'), 'marketing needs the carrier checkbox');
  assert.deepEqual(failing({ ...mk, carrier_submitted: 1 }), []);
  assert.ok(failing({ ...mk, carrier_submitted: 1, healthcare_setting: 'patient_care_area' }).includes('setting'));
  assert.deepEqual(failing({ ...mk, carrier_submitted: 1, healthcare_setting: 'common_area' }), [], 'common areas are OK');
  for (const meal of ['Lunch provided', 'catered', 'a light BUFFET', 'free food', 'Breakfast and coffee']) {
    assert.ok(failing({ ...mk, carrier_submitted: 1, refreshments: meal }).includes('meals'), meal);
  }
  assert.deepEqual(failing({ ...mk, carrier_submitted: 1, refreshments: 'Coffee and light snacks' }), []);
  const meals = checkEvent({ ...mk, carrier_submitted: 1, description: 'Join us for dinner.' }).blockers.find((b) => b.id === 'meals');
  assert.match(meals.message, /Meals can’t be provided at sales events/);
  assert.deepEqual(failing(base({ refreshments: 'Lunch' })), [], 'meal rule applies to sales events only');

  for (const [word, field] of [['free', 'title'], ['$0', 'summary'], ['the best plans', 'description'], ['#1 agent', 'title'], ['top-rated', 'summary'],
    ['guaranteed', 'description'], ['Medicare-approved', 'title'], ['Medicare approved', 'summary'], ['government', 'description'], ['official', 'title'],
    ['Social Security office', 'description']]) {
    const r = checkEvent(base({ [field]: `Something ${word} here` }));
    const b = r.blockers.find((x) => x.id === 'wording');
    assert.ok(b, `${word} blocked`);
  }
  const w = checkEvent(base({ description: 'Totally free and the best.' })).blockers.find((x) => x.id === 'wording');
  assert.match(w.message, /free/);
  assert.match(w.message, /best/);

  for (const sales of ['How to enroll', 'Bring your enrollment application', 'sign up for a plan', 'Plan benefits explained', 'Low premiums', 'Plans from $15', 'Humana plans', 'UnitedHealthcare', 'Devoted Health']) {
    assert.ok(failing(base({ summary: sales })).includes('edu_sales'), sales);
  }
  assert.deepEqual(failing(base({ summary: 'When Annual Enrollment happens' })), [], '"enrollment" period talk is fine');
  assert.ok(failing({ ...mk, carrier_submitted: 1, summary: 'Humana and Aetna plans' }).length === 0, 'sales events may name carriers');

  const seminar = checkEvent(base({ title: 'Medicare Seminar' }));
  assert.ok(seminar.warnings.some((x) => x.id === 'seminar_title'));
  assert.ok(!checkEvent(base({ title: 'Medicare seminar with Skip Jackson, licensed insurance agent' })).warnings.some((x) => x.id === 'seminar_title'));

  assert.ok(failing(base({ format: 'online', venue_name: null, address: null, city: null })).includes('join'), 'online needs join info');
  assert.deepEqual(failing(base({ format: 'online', online_join_info: 'link', rsvp_enabled: 0, venue_name: null, address: null, city: null })), [], 'online events need no RSVP (H1)');
  assert.ok(failing(base({ starts_at: at(-1), ends_at: at(-1, 20) })).includes('future'));
  assert.ok(failing(base({ ends_at: at(10, 17) })).includes('times'));
});

test('events: CRM, RBAC, public pages, RSVPs, ics, redirects', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await createUser(s.db, { email: 'admin@example.com', name: 'Admin', role: 'admin' });
  await createUser(s.db, { email: 'agent@example.com', name: 'Agent', role: 'agent' });
  const admin = await login(s.base, 'admin@example.com');
  const agent = await login(s.base, 'agent@example.com');
  const tok = (age = 60000) => s.app.ctx.formTokens.issue(Date.now() - age).token;
  // Posts an RSVP and follows the Post/Redirect/Get redirect to the confirmation page.
  const rsvp = async (slug, body, headers = {}) => {
    const r = await request(s.base, 'POST', `/events/${slug}/rsvp`, { form: { form_token: tok(), ...body }, headers: { origin: s.base, 'x-forwarded-for': '198.51.100.20', ...headers } });
    if (r.status !== 303) return r;
    assert.match(r.headers.get('location'), /^\/events\/[a-z0-9-]+\/confirmed\?t=[A-Za-z0-9_-]{32}$/);
    const c = await request(s.base, 'GET', r.headers.get('location'));
    return { ...c, redirectedFrom: r };
  };
  const create = async (c, over) => { const r = await c.post('/events', base(over)); assert.equal(r.status, 201, r.body); return r.json.id; };
  const get = async (id) => (await admin.get(`/events/${id}`)).json.event;

  await t.test('/login and /staff redirect to the CRM', async () => {
    for (const p of ['/login', '/staff']) {
      const r = await request(s.base, 'GET', p);
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/crm/');
    }
    assert.equal((await request(s.base, 'GET', '/login/x')).status, 404, 'exact paths only');
  });

  await t.test('home: no events -> marker renders nothing', async () => {
    const r = await request(s.base, 'GET', '/');
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /EVENTS:HOME|events-home/);
    const l = await request(s.base, 'GET', '/events/');
    assert.match(l.body, /No events are scheduled right now/);
    assert.equal(l.headers.get('cache-control'), 'no-store');
  });

  let eduId;
  await t.test('RBAC: agents draft but cannot publish, cancel or delete', async () => {
    eduId = await create(agent, { title: 'Medicare 101 <script>alert("x")</script>', description: 'First para.\n\nSecond <img src=x onerror=alert(1)> para.' });
    assert.equal((await agent.patch(`/events/${eduId}`, { capacity: 3 })).status, 200, 'agents edit drafts');
    assert.equal((await agent.post(`/events/${eduId}/publish`)).status, 403);
    assert.equal((await agent.post(`/events/${eduId}/cancel`, { reason: 'because' })).status, 403);
    assert.equal((await agent.del(`/events/${eduId}`)).status, 403);
    assert.equal((await admin.post(`/events/${eduId}/publish`)).status, 200);
    assert.equal((await agent.patch(`/events/${eduId}`, { capacity: 4 })).status, 403, 'agents cannot edit a published event');
    assert.equal((await agent.post(`/events/${eduId}/unpublish`)).status, 403);
    assert.equal((await admin.del(`/events/${eduId}`)).status, 409, 'published events are kept');
    assert.equal((await agent.get(`/events/${eduId}/rsvps`)).status, 200, 'agents can view RSVPs');
    assert.equal((await agent.get(`/events/${eduId}/rsvps.csv`)).status, 403, 'CSV is admin-only');
  });

  await t.test('publish is blocked by compliance problems', async () => {
    const id = await create(admin, { event_type: 'marketing', title: 'Free lunch and plan review' });
    const r = await admin.post(`/events/${id}/publish`);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'compliance');
    const ids = r.json.blockers.map((b) => b.id);
    for (const k of ['carrier', 'meals', 'wording']) assert.ok(ids.includes(k), k);
    assert.equal((await admin.del(`/events/${id}`)).status, 200, 'never-published drafts can be deleted');
  });

  await t.test('public pages escape everything and hide join info', async () => {
    const e = await get(eduId);
    const list = await request(s.base, 'GET', '/events/');
    assert.match(list.body, /Medicare 101 &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(list.body, /<script>alert/);
    const d = await request(s.base, 'GET', `/events/${e.slug}/`);
    assert.equal(d.status, 200);
    assert.doesNotMatch(d.body, /<script>alert|<img src=x/);
    assert.match(d.body, /<p>First para\.<\/p>\s*<p>Second &lt;img src=x onerror=alert\(1\)&gt; para\.<\/p>/);
    assert.match(d.body, /This is an educational event\. No plan-specific benefits/);
    assert.match(d.body, /maps\.google\.com\/\?q=/);
    const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(d.body.split('</head>')[0].split('EVENTS:HEAD').join(''));
    const lds = [...d.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const ev = lds.find((x) => x['@type'] === 'Event');
    assert.ok(ev && ev.name.includes('<script>'), 'JSON-LD has the (JSON-escaped) title');
    assert.equal(ev.isAccessibleForFree, undefined);
    assert.equal(ev.offers, undefined);
    assert.ok(ld === null || ld);

    const onlineId = await create(admin, { title: 'Online Medicare overview', format: 'online', venue_name: null, address: null, city: null, online_join_info: 'https://example.com/SECRET-JOIN-LINK' });
    assert.equal((await admin.post(`/events/${onlineId}/publish`)).status, 200);
    const oe = await get(onlineId);
    for (const p of ['/events/', `/events/${oe.slug}/`, `/events/${oe.slug}/calendar.ics`, '/']) {
      const r = await request(s.base, 'GET', p);
      assert.doesNotMatch(r.body, /SECRET-JOIN-LINK/, p);
    }
    const ok = await rsvp(oe.slug, { first_name: 'On', last_name: 'Line', email: 'online@example.com' });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /SECRET-JOIN-LINK/, 'join info only in the RSVP confirmation');
  });

  await t.test('home shows the next 3 events', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await create(admin, { title: `Later event ${i}`, starts_at: at(20 + i), ends_at: at(20 + i, 20) });
      await admin.post(`/events/${id}/publish`);
    }
    const r = await request(s.base, 'GET', '/');
    assert.match(r.body, /events-home/);
    assert.equal((r.body.match(/class="event-card/g) || []).length, 3);
    assert.match(r.body, /href="\.\/events\/"/);
  });

  await t.test('RSVP without permission stores only the RSVP', async () => {
    const e = await get(eduId);
    const before = s.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
    const r = await rsvp(e.slug, { first_name: 'Quiet', last_name: 'Guest', email: 'quiet@example.com', guests: '1' });
    assert.equal(r.status, 200);
    assert.match(r.body, /You’re signed up/);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, before, 'no contact');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Call back Quiet%'").get().n, 0, 'no callback task');
    const row = s.db.prepare("SELECT * FROM event_rsvps WHERE email = 'quiet@example.com'").get();
    assert.equal(row.contact_permission, 0);
    assert.equal(row.contact_id, null);
  });

  await t.test('RSVP with permission creates a contact + contact request (no SMS consent)', async () => {
    const e = await get(eduId);
    const r = await rsvp(e.slug, { first_name: 'Open', last_name: 'Door', phone: '4045550420', contact_permission: 'yes' });
    assert.equal(r.status, 200);
    const row = s.db.prepare("SELECT * FROM event_rsvps WHERE phone = '4045550420'").get();
    assert.ok(row.contact_id);
    const req = s.db.prepare('SELECT * FROM contact_requests WHERE contact_id = ?').get(row.contact_id);
    assert.equal(req.form_id, 'event-rsvp');
    assert.equal(s.db.prepare('SELECT source FROM contacts WHERE id = ?').get(row.contact_id).source, 'event');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM consents WHERE contact_id = ?').get(row.contact_id).n, 0, 'no text consent from RSVPs');
  });

  await t.test('capacity: full events refuse more RSVPs', async () => {
    const e = await get(eduId); // capacity 3: Quiet+1 and Open = 3 seats
    const r = await rsvp(e.slug, { first_name: 'Late', last_name: 'Comer', email: 'late@example.com' });
    assert.equal(r.status, 409);
    assert.match(r.body, /This event is full\. Call <a href="tel:\+14043547597">\(404\) 354-7597<\/a> to join the waitlist\./);
    const d = await request(s.base, 'GET', `/events/${e.slug}/`);
    assert.match(d.body, /This event is full/);
    assert.doesNotMatch(d.body, /name="first_name"/, 'no form when full');
  });

  await t.test('RSVP spam protection: honeypot, too fast, origin, rate limit, validation', async () => {
    const id = await create(admin, { title: 'Spam check event', capacity: null });
    await admin.post(`/events/${id}/publish`);
    const e = await get(id);
    const n = () => s.db.prepare('SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ?').get(id).n;
    let r = await rsvp(e.slug, { first_name: 'Bot', last_name: 'One', email: 'b1@example.com', website: 'spam' }, { 'x-forwarded-for': '198.51.100.30' });
    assert.equal(r.status, 200);
    r = await rsvp(e.slug, { first_name: 'Bot', last_name: 'Two', email: 'b2@example.com', form_token: tok(500) }, { 'x-forwarded-for': '198.51.100.31' });
    assert.equal(r.status, 200);
    assert.equal(n(), 0, 'nothing stored for bots');
    r = await rsvp(e.slug, { first_name: 'X', last_name: 'Site', email: 'x@example.com' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await rsvp(e.slug, { first_name: '', last_name: 'Nameless' }, { 'x-forwarded-for': '198.51.100.32' });
    assert.equal(r.status, 400);
    assert.match(r.body, /Please enter your first name/);
    assert.match(r.body, /value="Nameless"/, 'values kept');
    for (let i = 0; i < 5; i++) assert.equal((await rsvp(e.slug, { first_name: 'Ok', last_name: `P${i}`, email: `p${i}@example.com` }, { 'x-forwarded-for': '198.51.100.33' })).status, 200);
    r = await rsvp(e.slug, { first_name: 'Ok', last_name: 'P9', email: 'p9@example.com' }, { 'x-forwarded-for': '198.51.100.33' });
    assert.equal(r.status, 429);
  });

  await t.test('.ics download uses Georgia time and includes the disclosure', async () => {
    const e = await get(eduId);
    const r = await request(s.base, 'GET', `/events/${e.slug}/calendar.ics`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/calendar/);
    assert.match(r.body, /\r\nBEGIN:VTIMEZONE\r\nTZID:America\/New_York\r\n/);
    const { zonedParts } = require('../server/time');
    const p = zonedParts(new Date(e.starts_at));
    const local = `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}${String(p.mi).padStart(2, '0')}00`;
    assert.match(r.body, new RegExp(`\\r\\nDTSTART;TZID=America/New_York:${local}\\r\\n`));
    const unfolded = r.body.replace(/\r\n /g, '');
    assert.match(unfolded, /DESCRIPTION:.*This is an educational event/);
    assert.ok(r.body.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines folded at 75 octets');
  });

  await t.test('cancelled shows with reason; past and draft events never show', async () => {
    const e = await get(eduId);
    assert.equal((await admin.post(`/events/${eduId}/cancel`, { reason: 'The library is closed for repairs.' })).status, 200);
    const list = await request(s.base, 'GET', '/events/');
    assert.match(list.body, /This event is cancelled\.<\/strong> The library is closed for repairs\./);
    const d = await request(s.base, 'GET', `/events/${e.slug}/`);
    assert.match(d.body, /This event is cancelled/);
    assert.doesNotMatch(d.body, /name="first_name"/);
    assert.equal((await rsvp(e.slug, { first_name: 'A', last_name: 'B', email: 'ab@example.com' }, { 'x-forwarded-for': '198.51.100.50' })).status, 409);

    const draft = await create(admin, { title: 'Secret draft event' });
    const dr = await get(draft);
    assert.equal((await request(s.base, 'GET', `/events/${dr.slug}/`)).status, 404);
    assert.doesNotMatch((await request(s.base, 'GET', '/events/')).body, /Secret draft event/);
    const prev = await admin.get(`/events/${draft}/preview`);
    assert.equal(prev.status, 200);
    assert.match(prev.body, /Secret draft event/);
    assert.match(prev.body, /Preview/);
    assert.equal((await request(s.base, 'GET', `/crm/api/events/${draft}/preview`)).status, 401, 'preview needs sign-in');

    const pastId = await create(admin, { title: 'Already happened' });
    await admin.post(`/events/${pastId}/publish`);
    s.db.prepare('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?').run(at(-3), at(-3, 20), pastId);
    const pe = await get(pastId);
    assert.doesNotMatch((await request(s.base, 'GET', '/events/')).body, /Already happened/);
    assert.equal((await request(s.base, 'GET', `/events/${pe.slug}/`)).status, 404);
    assert.equal((await request(s.base, 'GET', `/events/${pe.slug}/calendar.ics`)).status, 404);
  });

  await t.test('same-day educational + sales at one venue warns on both', async () => {
    const day = at(30, 14);
    const edu = await create(admin, { title: 'Morning basics', starts_at: day, ends_at: at(30, 15) });
    const mk = await create(admin, { title: 'Afternoon plan options', event_type: 'marketing', carrier_submitted: 1, starts_at: at(30, 16), ends_at: at(30, 17), address: '1  example st', city: 'decatur' });
    for (const id of [edu, mk]) {
      const e = await get(id);
      const w = e.compliance.warnings.find((x) => x.id === 'pairing');
      assert.ok(w, `warning on ${id}`);
      assert.match(w.message, /announce that the educational event is ending/);
      assert.ok(e.compliance.blockers.some((b) => b.id === 'pairing_ack'), 'publishing needs the hand-off confirmation');
      await admin.patch(`/events/${id}`, { pairing_ack: true });
      assert.equal((await get(id)).compliance.ok, true);
    }
    const other = await create(admin, { title: 'Elsewhere', starts_at: day, ends_at: at(30, 15), address: '9 Other Rd' });
    assert.ok(!(await get(other)).compliance.warnings.some((x) => x.id === 'pairing'));
  });

  await t.test('RSVP CSV export is audited and injection-safe; dashboard lists upcoming events', async () => {
    const id = await create(admin, { title: 'CSV check' });
    await admin.post(`/events/${id}/publish`);
    const e = await get(id);
    await rsvp(e.slug, { first_name: '=cmd', last_name: '+x', email: 'csv@example.com' }, { 'x-forwarded-for': '198.51.100.60' });
    const r = await admin.get(`/events/${id}/rsvps.csv`);
    assert.equal(r.status, 200);
    assert.match(r.body, /'=cmd,'\+x/);
    assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'export' AND entity = 'event_rsvps' AND entity_id = ?").get(id));
    const dash = (await admin.get('/dashboard')).json;
    assert.ok(Array.isArray(dash.upcoming_events));
    const dup = await agent.post(`/events/${id}/duplicate`);
    assert.equal(dup.status, 201);
    const copy = await get(dup.json.id);
    assert.equal(copy.status, 'draft');
    assert.equal(copy.carrier_submitted, 0);
    assert.notEqual(copy.slug, e.slug);
  });
});
