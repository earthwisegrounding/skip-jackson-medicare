'use strict';
// Files we create (database, WAL, backups, secrets) are private to this user.
process.umask(0o077);
// Load obviously FAKE demo data (555-01xx phone numbers, example.com emails, made-up names).
//
//   DATA_DIR=./data-demo npm run seed:demo
//   DATA_DIR=./data-demo CRM_PASSWORD='choose-a-long-one' npm run seed:demo   (also creates demo users)
//
// Refuses to run against the default data directory unless --force is given, and refuses
// to add demo data to a database that already has contacts unless --force is given.

const path = require('node:path');
const { openDb, insert, tx } = require('../server/db');
const { hashPassword, passwordProblem } = require('../server/auth');
const { storeLead } = require('../server/leads');
const S = require('../server/services');
const { turning65FromDob, localMonth, addMonths } = require('../server/time');
const { WEB_CONSENT_TEXT, WEB_CONSENT_VERSION } = require('../server/constants');

const force = process.argv.includes('--force');
if (!process.env.DATA_DIR && !force) {
  console.error('Refusing to seed: set DATA_DIR to a separate demo folder (e.g. DATA_DIR=./data-demo), or pass --force.');
  process.exit(1);
}
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const DAY = 864e5;
const HOUR = 3600e3;
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const ymd = (t) => iso(t).slice(0, 10);
let phoneN = 100;
const phone = () => `404555${String(phoneN++).padStart(4, '0')}`; // 404-555-0100..0199 are fictional

async function main() {
  const db = openDb(dataDir);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  if (existing && !force) {
    console.error(`This database already has ${existing} contacts. Use a fresh DATA_DIR, or pass --force to add demo data anyway.`);
    process.exit(1);
  }

  let adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get()?.id || null;
  let agentId = null;
  if (process.env.CRM_PASSWORD) {
    const problem = passwordProblem(process.env.CRM_PASSWORD);
    if (problem) throw new Error(problem);
    const hash = await hashPassword(process.env.CRM_PASSWORD);
    const t = iso(now);
    for (const [name, email, role] of [['Demo Admin', 'admin@example.com', 'admin'], ['Demo Assistant', 'assistant@example.com', 'agent']]) {
      const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      const id = u ? u.id : Number(db.prepare('INSERT INTO users (name, email, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(name, email, role, hash, t, t).lastInsertRowid);
      if (role === 'admin') adminId = id; else agentId = id;
    }
    console.log('Demo users: admin@example.com (admin) and assistant@example.com (agent), password from CRM_PASSWORD.');
  }
  const users = [adminId, agentId || adminId];
  const actor = adminId ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(adminId) : null;

  tx(db, () => {
    // ---- Website leads, through the real intake logic ----
    const webLeads = [
      ['Dora', 'Demo', 'turning-65', 'Turning 65 in March and not sure where to start.', true],
      ['Sam', 'Sample', 'leaving-employer', 'Retiring from the county in January.', true],
      ['Tess', 'Testcase', 'review-plan', 'My premium went up. Can we look at other plans?', false],
      ['Pat', 'Placeholder', 'helping-parent', 'Helping my mother compare drug plans.', true],
    ];
    for (const [first, last, topic, message, consent] of webLeads) {
      storeLead(db, {
        first_name: first, last_name: last, phone: phone(), email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, zip: '30303',
        topic, preferred_contact: 'phone', preferred_time: 'Weekday mornings', meeting_type: 'phone', message,
        consent_texts: consent ? 'yes' : null, form_id: 'home-request', source_page: '/', turning_65: topic === 'turning-65' ? addMonths(localMonth(), 5) : null,
      }, { ip: '203.0.113.10', userAgent: 'Demo seed' });
    }

    // ---- Contacts in every stage ----
    const people = [
      ['Ollie', 'Example', 'contacted', '1960-02-14', 'Atlanta', 'Fulton'],
      ['Mona', 'Mockup', 'appointment_set', '1961-11-03', 'Decatur', 'DeKalb'],
      ['Eddie', 'Exampleton', 'appointment_set', '1958-07-21', 'Marietta', 'Cobb'],
      ['Polly', 'Prototype', 'comparing_plans', '1957-04-09', 'Roswell', 'Fulton'],
      ['Danny', 'Dummy', 'application_submitted', '1959-12-30', 'Smyrna', 'Cobb'],
      ['Fiona', 'Fakename', 'enrolled', '1955-05-05', 'Lawrenceville', 'Gwinnett'],
      ['Fred', 'Fictional', 'enrolled', '1952-09-17', 'Duluth', 'Gwinnett'],
      ['Greta', 'Gridline', 'enrolled', '1949-01-25', 'Athens', 'Clarke'],
      ['Wanda', 'Whatif', 'not_now', '1960-08-08', 'Macon', 'Bibb'],
      ['Larry', 'Loremipsum', 'new', '1961-06-12', 'Savannah', 'Chatham'],
      ['Nina', 'Nobody', 'contacted', '1961-03-02', 'Columbus', 'Muscogee'],
      ['Ivan', 'Imaginary', 'lost', '1956-10-10', 'Augusta', 'Richmond'],
    ];
    const ids = {};
    people.forEach(([first, last, stage, dob, city, county], i) => {
      const created = now - (40 - i * 2) * DAY;
      const id = insert(db, 'contacts', {
        first_name: first, last_name: last, phone: phone(), email: `${first.toLowerCase()}@example.com`, city, county, state: 'GA', zip: '30301',
        date_of_birth: dob, turning_65: turning65FromDob(dob), stage, source: i % 3 === 0 ? 'referral' : 'website', topic: 'review-plan',
        preferred_contact: i % 2 ? 'phone' : 'email', assigned_user_id: users[i % 2], tags: i % 4 === 0 ? 'demo, referral' : 'demo',
        current_coverage: stage === 'enrolled' ? 'See policies tab' : 'Employer group plan (demo)', created_at: iso(created), updated_at: iso(created),
      });
      ids[first] = id;
      S.addActivity(db, { contactId: id, type: 'system', body: 'Demo contact created by seed script.', occurredAt: iso(created) });
      if (stage !== 'new') {
        S.addActivity(db, { contactId: id, type: 'call', direction: 'out', body: 'Intro call (demo). Explained how I work and that there is no cost for my help.', occurredAt: iso(created + DAY), userId: users[i % 2], recorded: 1, duration_min: 12 });
      }
    });
    // Turning 65 soon (by DOB)
    const soonDob = `${Number(addMonths(localMonth(), 3).slice(0, 4)) - 65}-${addMonths(localMonth(), 3).slice(5, 7)}-15`;
    const t65 = insert(db, 'contacts', { first_name: 'Tilly', last_name: 'Turnsixtyfive', phone: phone(), email: 'tilly@example.com', state: 'GA', zip: '30305', date_of_birth: soonDob,
      turning_65: turning65FromDob(soonDob), stage: 'contacted', source: 'referral', topic: 'turning-65', assigned_user_id: adminId, created_at: iso(now - 9 * DAY), updated_at: iso(now - 9 * DAY) });
    S.addActivity(db, { contactId: t65, type: 'note', body: 'Part A effective date pending from Social Security (demo).', userId: adminId, occurredAt: iso(now - 9 * DAY) });

    // ---- Appointments + SOAs: OK, missing, recorded late, verbal for in-person ----
    const ap = (contact, startT, type, soa) => {
      const aid = insert(db, 'appointments', { contact_id: contact, starts_at: iso(startT), ends_at: iso(startT + HOUR), type, status: startT < now ? 'completed' : 'scheduled',
        location: type === 'in-person' ? 'Demo office, Atlanta' : null, user_id: adminId, created_at: iso(now - 5 * DAY), updated_at: iso(now - 5 * DAY) });
      if (soa) {
        const sid = insert(db, 'scope_of_appointments', { contact_id: contact, appointment_id: aid, products: JSON.stringify(soa.products), signature_method: soa.method,
          signed_at: iso(soa.signed), initiated_by: soa.by, notes: soa.notes || null, created_by: adminId, created_at: iso(soa.signed), updated_at: iso(soa.signed) });
        db.prepare('UPDATE appointments SET soa_id = ? WHERE id = ?').run(sid, aid);
      }
      return aid;
    };
    ap(ids.Mona, now + 2 * DAY + 3 * HOUR, 'phone', { products: ['medicare_advantage', 'part_d'], method: 'electronic', signed: now - 2 * DAY, by: 'agent' });
    ap(ids.Eddie, now + 1 * DAY, 'in-person', { products: ['medicare_advantage'], method: 'verbal_recorded', signed: now - 3 * HOUR, by: 'beneficiary' });
    ap(ids.Polly, now + 3 * DAY, 'video', null);
    ap(ids.Ollie, now + 4 * DAY, 'phone', { products: ['medigap'], method: 'verbal_recorded', signed: now - 1 * HOUR, by: 'agent' });
    ap(ids.Nina, now - 2 * DAY, 'video', { products: ['part_d'], method: 'electronic', signed: now - 2 * DAY + 2 * HOUR, by: 'agent' });
    ap(ids.Fiona, now - 20 * DAY, 'in-person', { products: ['medicare_advantage', 'dental_vision_hearing'], method: 'paper', signed: now - 25 * DAY, by: 'beneficiary' });

    // ---- Policies ----
    const pol = (contact, carrier, type, status, eff, extra = {}) => insert(db, 'policies', {
      contact_id: contact, carrier, plan_type: type, plan_name: `${carrier} Demo ${type} Plan`, plan_id: type === 'Medigap' ? null : `H${1000 + contact}-00${contact % 9}`,
      effective_date: eff, status, election_period: 'AEP', application_submitted_at: ymd(now - 10 * DAY), application_number: `DEMO-${contact}${status.length}`,
      premium: type === 'Medigap' ? 142.5 : 0, created_by: adminId, created_at: iso(now - 30 * DAY), updated_at: iso(now - 30 * DAY), ...extra,
    });
    pol(ids.Danny, 'Humana', 'MAPD', 'pending', ymd(now + 20 * DAY));
    pol(ids.Fiona, 'Aetna', 'MAPD', 'active', '2025-01-01');
    pol(ids.Fiona, 'Wellcare', 'Dental/Vision', 'active', '2025-01-01');
    pol(ids.Fred, 'UnitedHealthcare', 'Medigap', 'active', '2024-06-01');
    pol(ids.Fred, 'Wellcare', 'PDP', 'active', '2025-01-01');
    pol(ids.Greta, 'Devoted Health', 'D-SNP', 'active', '2025-03-01');
    pol(ids.Greta, 'HealthSpring', 'MAPD', 'terminated', '2023-01-01', { end_date: '2025-02-28' });
    S.addActivity(db, { contactId: ids.Greta, type: 'call', direction: 'out', body: 'Annual review done (demo).', userId: adminId, recorded: 1, duration_min: 20, occurredAt: iso(now - 2 * DAY) });

    // ---- Consents ----
    S.recordConsent(db, { contact_id: ids.Fiona, channel: 'email', granted: 1, email: 'fiona@example.com', consent_text: 'Agreed by phone to receive plan updates by email (demo).', source: 'verbal', recorded_by_user_id: adminId, captured_at: iso(now - 30 * DAY) });
    S.recordConsent(db, { contact_id: ids.Fred, channel: 'text', granted: 1, phone: '4045550199', consent_text: WEB_CONSENT_TEXT, text_version: WEB_CONSENT_VERSION, source: 'web_form', captured_at: iso(now - 60 * DAY), ip: '203.0.113.20' });
    S.recordConsent(db, { contact_id: ids.Fred, channel: 'text', granted: 0, source: 'manual', notes: 'Replied STOP (demo).', recorded_by_user_id: adminId, captured_at: iso(now - 15 * DAY) });

    // ---- Do-not-contact person who came back through the website ----
    const wanda = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ids.Wanda);
    S.setDnc(db, wanda, true, { reason: 'Asked not to be called (demo)', user: actor });
    const w = db.prepare('SELECT phone FROM contacts WHERE id = ?').get(ids.Wanda);
    storeLead(db, { first_name: 'Wanda', last_name: 'Whatif', phone: w.phone, email: null, topic: 'other', preferred_contact: 'email', message: 'Actually I do have a question now (demo).', form_id: 'contact-page', source_page: '/contact/' },
      { ip: '203.0.113.30', userAgent: 'Demo seed' });

    // ---- Tasks ----
    const task = (title, due, contact, user = adminId, priority = 'normal') => insert(db, 'tasks', { title, due_at: iso(due), contact_id: contact, assigned_user_id: user, priority, created_by: adminId, created_at: iso(now - DAY), updated_at: iso(now - DAY) });
    task('Send Polly the plan comparison', now - DAY, ids.Polly, adminId, 'high');
    task('Confirm Danny’s application status with carrier', now + 2 * HOUR, ids.Danny);
    task('Mail Fiona her welcome packet checklist', now + 3 * DAY, ids.Fiona, agentId || adminId, 'low');
    task('Renew state license CE credits (demo)', now + 14 * DAY, null);
  });

  const counts = ['contacts', 'activities', 'tasks', 'appointments', 'scope_of_appointments', 'policies', 'consents'].map((t) => `${t}: ${db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n}`);
  console.log(`Demo data loaded into ${path.join(dataDir, 'crm.db')}\n  ${counts.join('\n  ')}`);
  if (!adminId) console.log('No users yet. Create one: DATA_DIR=... npm run create-user -- --email you@example.com --name "You" --role admin');
  db.close();
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
