'use strict';
// Dashboard, compliance center, reports, CSV exports, audit log.

const C = require('../constants');
const { toCsv } = require('../csv');
const { localDate, localMonth, addMonths, aepStatus, startOfLocalDay, addDaysLocal, localDateTimeText } = require('../time');
const { auditR, paging } = require('./helpers');
const { decorateAppointment, LAST_CONTACTED_SQL } = require('./records');
const { SOA_VALID_MONTHS } = require('../compliance');
const { upcomingForDashboard } = require('./events');
const { formatPhone } = require('../validate');

const admin = { role: 'admin' };

function registerOverviewRoutes(router, ctx) {
  const { db } = ctx;

  router.get('/dashboard', (r) => {
    const now = new Date();
    const today = localDate(now);
    const endOfToday = addDaysLocal(startOfLocalDay(now), 1).toISOString();
    const in7 = new Date(now.getTime() + 7 * 864e5).toISOString();
    const month = localMonth(now);
    const aep = aepStatus(now);

    const stageCounts = Object.fromEntries(C.STAGES.map(([s]) => [s, 0]));
    for (const row of db.prepare('SELECT stage, COUNT(*) AS n FROM contacts WHERE archived_at IS NULL GROUP BY stage').all()) stageCounts[row.stage] = row.n;

    const newLeads = db.prepare(`SELECT c.id, c.first_name, c.last_name, c.phone, c.email, c.topic, c.preferred_contact, c.preferred_time, c.do_not_contact, c.source,
        COALESCE((SELECT MAX(occurred_at) FROM activities a WHERE a.contact_id = c.id AND a.type = 'web_form'), c.created_at) AS received_at
      FROM contacts c WHERE c.stage = 'new' AND c.archived_at IS NULL ORDER BY received_at ASC LIMIT 50`).all();

    const tasks = db.prepare(`SELECT t.*, u.name AS assigned_name, c.first_name, c.last_name, c.phone, c.do_not_contact FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_user_id LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.done_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < ? AND (t.contact_id IS NULL OR (c.archived_at IS NULL AND c.deleted_at IS NULL))
      ORDER BY t.due_at LIMIT 100`).all(endOfToday);

    const appointments = db.prepare(`SELECT a.*, c.first_name, c.last_name, c.phone, c.do_not_contact FROM appointments a JOIN contacts c ON c.id = a.contact_id
      WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status = 'scheduled' ORDER BY a.starts_at`).all(new Date(now.getTime() - 2 * 3600e3).toISOString(), in7)
      .map((a) => decorateAppointment(db, a));

    const turning65 = db.prepare(`SELECT id, first_name, last_name, turning_65, date_of_birth, stage, phone FROM contacts
      WHERE archived_at IS NULL AND do_not_contact = 0 AND turning_65 IS NOT NULL AND turning_65 >= ? AND turning_65 <= ? ORDER BY turning_65, last_name LIMIT 100`)
      .all(month, addMonths(month, 6));

    const effective = db.prepare(`SELECT p.*, c.first_name, c.last_name FROM policies p JOIN contacts c ON c.id = p.contact_id
      WHERE p.status IN ('pending','active') AND p.effective_date >= ? AND p.effective_date <= ? ORDER BY p.effective_date LIMIT 100`)
      .all(today, localDate(new Date(now.getTime() + 30 * 864e5)));

    const review = db.prepare(`SELECT * FROM (SELECT c.id, c.first_name, c.last_name, c.phone, ${LAST_CONTACTED_SQL} AS last_contacted_at,
        (SELECT GROUP_CONCAT(p.carrier || ' ' || p.plan_type, '; ') FROM policies p WHERE p.contact_id = c.id AND p.status = 'active') AS plans
      FROM contacts c WHERE c.archived_at IS NULL AND c.do_not_contact = 0
        AND EXISTS (SELECT 1 FROM policies p WHERE p.contact_id = c.id AND p.status = 'active'))
      WHERE last_contacted_at IS NULL OR last_contacted_at < ? ORDER BY last_contacted_at IS NOT NULL, last_contacted_at LIMIT 100`).all(aep.review_since);

    const dncWarnings = db.prepare(`SELECT cr.id AS request_id, cr.requested_at, cr.form_id, c.id, c.first_name, c.last_name, c.dnc_reason, c.dnc_at
      FROM contact_requests cr JOIN contacts c ON c.id = cr.contact_id
      WHERE cr.while_dnc = 1 AND cr.dnc_reviewed_at IS NULL AND c.do_not_contact = 1 ORDER BY cr.requested_at DESC LIMIT 50`).all();

    // Contact permission from a website request lasts 12 months (42 CFR 422.2264(c)(3)(iii)).
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - SOA_VALID_MONTHS);
    const permissionExpired = db.prepare(`SELECT * FROM (SELECT c.id, c.first_name, c.last_name, c.stage, c.phone,
        (SELECT MAX(requested_at) FROM contact_requests cr WHERE cr.contact_id = c.id) AS last_request_at
      FROM contacts c WHERE c.archived_at IS NULL AND c.do_not_contact = 0 AND c.stage != 'enrolled'
        AND NOT EXISTS (SELECT 1 FROM policies p WHERE p.contact_id = c.id AND p.status IN ('active','pending')))
      WHERE last_request_at IS NOT NULL AND last_request_at < ? ORDER BY last_request_at LIMIT 100`).all(cutoff.toISOString());

    return {
      upcoming_events: upcomingForDashboard(db, 14),
      permission_expired: permissionExpired,
      today, aep, stage_counts: stageCounts, new_leads: newLeads, tasks, appointments, turning_65: turning65,
      effective_soon: effective, annual_review: review, dnc_warnings: dncWarnings, user: r.user,
    };
  });

  router.get('/compliance', (r) => {
    const now = Date.now();
    const appts = db.prepare(`SELECT a.*, c.first_name, c.last_name FROM appointments a JOIN contacts c ON c.id = a.contact_id
      WHERE c.deleted_at IS NULL AND a.starts_at >= ? ORDER BY a.starts_at LIMIT 500`).all(new Date(now - 90 * 864e5).toISOString())
      .map((a) => decorateAppointment(db, a)).filter((a) => ['danger', 'warn'].includes(a.compliance.level));
    const dnc = db.prepare('SELECT id, first_name, last_name, phone, email, dnc_reason, dnc_at FROM contacts WHERE do_not_contact = 1 AND deleted_at IS NULL ORDER BY dnc_at DESC LIMIT ?').all(r.user.role === 'admin' ? 500 : 100);
    const consents = db.prepare(`SELECT cs.id, cs.contact_id, cs.channel, cs.granted, cs.effective, cs.review_reason, cs.source, cs.text_version, cs.captured_at, cs.form_id, cs.ip,
        c.first_name, c.last_name, u.name AS recorded_by FROM consents cs JOIN contacts c ON c.id = cs.contact_id
        LEFT JOIN users u ON u.id = cs.recorded_by_user_id ORDER BY cs.captured_at DESC, cs.id DESC LIMIT 100`).all();
    const soas = db.prepare(`SELECT s.*, c.first_name, c.last_name, u.name AS created_by_name FROM scope_of_appointments s JOIN contacts c ON c.id = s.contact_id
      LEFT JOIN users u ON u.id = s.created_by ORDER BY s.signed_at DESC LIMIT 100`).all().map((s) => ({ ...s, products: JSON.parse(s.products) }));
    const requests = db.prepare(`SELECT cr.id, cr.contact_id, cr.requested_at, cr.topic, cr.preferred_contact, cr.form_id, cr.source_page, cr.while_dnc,
        cr.match_type, cr.verified, cr.submitted_name,
        c.first_name, c.last_name FROM contact_requests cr JOIN contacts c ON c.id = cr.contact_id ORDER BY cr.requested_at DESC LIMIT 100`).all();
    const exportsList = r.user.role === 'admin'
      ? db.prepare("SELECT id, user_name, entity, summary, ip, at FROM audit_log WHERE action = 'export' ORDER BY at DESC LIMIT 50").all() : null;
    auditR(db, r, 'list', 'compliance', null, `appointments=${appts.length}; dnc=${dnc.length}; consents=${consents.length}; soas=${soas.length}; requests=${requests.length}`);
    return { appointments: appts, dnc, consents, soas, contact_requests: requests, exports: exportsList };
  });

  router.get('/reports', (r) => {
    const year = Number(r.query.get('year')) || Number(localDate().slice(0, 4));
    const from = `${year}-01-01`;
    const to = `${year + 1}-01-01`;
    const order = Object.fromEntries(C.STAGES.map(([s], i) => [s, i]));
    const funnel = C.STAGES.filter(([s]) => !['not_now', 'lost'].includes(s));
    const contacts = db.prepare('SELECT id, stage, source FROM contacts WHERE created_at >= ? AND created_at < ?').all(from, to);
    const reached = Object.fromEntries(funnel.map(([s]) => [s, 0]));
    const history = db.prepare("SELECT contact_id, meta FROM activities WHERE type = 'stage_change'").all();
    const maxByContact = new Map();
    for (const h of history) {
      try {
        const to2 = JSON.parse(h.meta).to;
        if (order[to2] !== undefined && order[to2] < order.not_now) maxByContact.set(h.contact_id, Math.max(maxByContact.get(h.contact_id) ?? 0, order[to2]));
      } catch { /* ignore */ }
    }
    const sources = {};
    for (const c of contacts) {
      const cur = order[c.stage] < order.not_now ? order[c.stage] : 0;
      const max = Math.max(cur, maxByContact.get(c.id) ?? 0);
      for (const [s] of funnel) if (order[s] <= max) reached[s] += 1;
      const src = c.source || 'unknown';
      sources[src] = (sources[src] || 0) + 1;
    }
    const byCarrier = db.prepare(`SELECT carrier, plan_type, status, COUNT(*) AS n FROM policies WHERE status IN ('active','pending')
      GROUP BY carrier, plan_type, status ORDER BY carrier, plan_type`).all();
    const enrolledThisYear = db.prepare(`SELECT COUNT(*) AS n FROM policies WHERE application_submitted_at >= ? AND application_submitted_at < ?`).get(from, to).n;
    return { year, total_contacts: contacts.length, funnel: funnel.map(([s, label]) => ({ stage: s, label, count: reached[s] })),
      sources, policies_by_carrier: byCarrier, applications_this_year: enrolledThisYear };
  }, admin);

  // ---------------- CSV exports ----------------
  const yesNo = (v) => (v ? 'yes' : 'no');
  // Timestamps are exported in Georgia (Eastern) local time with friendly column headers.
  const lt = (key, label) => ({ key, label: `${label} (Eastern)`, get: (x) => localDateTimeText(x[key]) });
  const col = (key, label) => ({ key, label });
  const STAGE = Object.fromEntries(C.STAGES);
  const TOPIC = Object.fromEntries(C.TOPICS);
  const EXPORTS = {
    contacts: {
      sql: `SELECT c.*, u.name AS assigned_name FROM contacts c LEFT JOIN users u ON u.id = c.assigned_user_id WHERE c.deleted_at IS NULL ORDER BY c.last_name, c.first_name`,
      columns: [col('id', 'Contact ID'), col('first_name', 'First name'), col('last_name', 'Last name'), col('preferred_name', 'Goes by'),
        { key: 'phone', label: 'Phone', get: (x) => formatPhone(x.phone) }, col('email', 'Email'), col('address', 'Street address'), col('city', 'City'),
        col('county', 'County'), col('state', 'State'), col('zip', 'ZIP'), col('date_of_birth', 'Date of birth'), col('turning_65', 'Turning 65 (month)'),
        col('medicare_a_effective', 'Part A effective'), col('medicare_b_effective', 'Part B effective'), col('current_coverage', 'Current coverage'),
        { key: 'stage', label: 'Stage', get: (x) => STAGE[x.stage] || x.stage }, col('source', 'Source'), { key: 'topic', label: 'Topic', get: (x) => TOPIC[x.topic] || x.topic || '' },
        col('preferred_contact', 'Prefers'), col('preferred_time', 'Best time'), col('tags', 'Tags'), col('assigned_name', 'Assigned to'),
        { key: 'do_not_contact', label: 'Do not contact', get: (x) => yesNo(x.do_not_contact) }, col('dnc_reason', 'DNC reason'), lt('dnc_at', 'DNC since'),
        lt('archived_at', 'Archived'), lt('created_at', 'Created'), lt('updated_at', 'Updated')],
    },
    policies: {
      sql: `SELECT p.*, c.first_name, c.last_name FROM policies p JOIN contacts c ON c.id = p.contact_id WHERE c.deleted_at IS NULL ORDER BY c.last_name, p.effective_date`,
      columns: [col('id', 'Policy ID'), col('contact_id', 'Contact ID'), col('first_name', 'First name'), col('last_name', 'Last name'), col('carrier', 'Carrier'),
        col('plan_name', 'Plan name'), col('plan_type', 'Plan type'), col('plan_id', 'Plan ID'), col('effective_date', 'Effective date'), col('end_date', 'End date'),
        col('status', 'Status'), col('election_period', 'Election period'), col('application_submitted_at', 'Application submitted'),
        col('application_number', 'Application number'), col('premium', 'Monthly premium'), col('notes', 'Notes'), lt('created_at', 'Created'), lt('updated_at', 'Updated')],
    },
    consents: {
      sql: `SELECT cs.*, c.first_name, c.last_name, u.name AS recorded_by FROM consents cs JOIN contacts c ON c.id = cs.contact_id
        LEFT JOIN users u ON u.id = cs.recorded_by_user_id ORDER BY cs.captured_at, cs.id`,
      columns: [col('id', 'Consent ID'), col('contact_id', 'Contact ID'), col('first_name', 'First name'), col('last_name', 'Last name'), col('channel', 'Channel'),
        { key: 'granted', label: 'Change', get: (x) => (x.granted ? 'granted' : 'revoked') },
        { key: 'effective', label: 'In effect', get: (x) => (x.effective ? 'yes' : 'no — held for review') }, col('review_reason', 'Review reason'),
        { key: 'phone', label: 'Phone', get: (x) => formatPhone(x.phone) }, col('email', 'Email'), col('source', 'Source'), col('text_version', 'Wording version'),
        col('consent_text', 'Wording'), col('form_id', 'Form'), col('source_page', 'Page'), col('notes', 'Notes'), lt('captured_at', 'Captured'),
        col('ip', 'IP address'), col('user_agent', 'Browser'), col('recorded_by', 'Recorded by')],
    },
  };

  router.get('/export/:name', (r) => {
    const name = r.params.name.replace(/\.csv$/, '');
    const def = Object.hasOwn(EXPORTS, name) ? EXPORTS[name] : null;
    if (!def) { r.res.writeHead(404, { 'Content-Type': 'application/json' }); r.res.end('{"error":"not_found"}'); return undefined; }
    const rows = db.prepare(def.sql).all();
    const csv = toCsv(def.columns, rows);
    auditR(db, r, 'export', name, null, `${rows.length} rows`);
    const file = `${name}-${localDate()}.csv`;
    r.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"`,
      'Content-Length': Buffer.byteLength(csv),
    });
    r.res.end(csv);
    return undefined;
  }, admin);

  // ---------------- Audit log ----------------
  router.get('/audit', (r) => {
    const q = r.query;
    const where = [];
    const p = {};
    if (q.get('user_id') && /^\d+$/.test(q.get('user_id'))) { where.push('user_id = :uid'); p.uid = Number(q.get('user_id')); }
    if (q.get('action')) { where.push('action = :action'); p.action = q.get('action').slice(0, 40); }
    if (q.get('entity')) { where.push('entity = :entity'); p.entity = q.get('entity').slice(0, 40); }
    if (q.get('entity_id') && /^\d+$/.test(q.get('entity_id'))) { where.push('entity_id = :eid'); p.eid = Number(q.get('entity_id')); }
    if (q.get('from') && /^\d{4}-\d{2}-\d{2}/.test(q.get('from'))) { where.push('at >= :from'); p.from = q.get('from'); }
    if (q.get('to') && /^\d{4}-\d{2}-\d{2}/.test(q.get('to'))) { where.push('at < :to'); p.to = q.get('to') + (q.get('to').length === 10 ? 'T23:59:59.999Z' : ''); }
    const { page, perPage, offset } = paging(q, { max: 200, def: 50 });
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${w}`).get(p).n;
    const items = db.prepare(`SELECT * FROM audit_log ${w} ORDER BY at DESC, id DESC LIMIT :limit OFFSET :offset`).all({ ...p, limit: perPage, offset });
    const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((x) => x.action);
    return { items, total, page, per_page: perPage, actions };
  }, admin);
}

module.exports = { registerOverviewRoutes };
