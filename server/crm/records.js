'use strict';
// Contacts and everything attached to them.

const C = require('../constants');
const { T, Invalid } = require('../validate');
const { insert, update, tx, normText } = require('../db');
const S = require('../services');
const { soaCompliance, permissionExpiresAt } = require('../compliance');
const { turning65FromDob, localDate, formatLocal } = require('../time');
const { fail, check, mustGet, auditR, changedFields, paging, likeEscape, created, userExists } = require('./helpers');

const k = C.keys;
const admin = { role: 'admin' };

const contactSchema = {
  first_name: { type: T.string(60), required: true, label: 'First name' },
  last_name: { type: T.string(60), required: true, label: 'Last name' },
  preferred_name: { type: T.string(60) },
  phone: { type: T.phone() },
  email: { type: T.email() },
  address: { type: T.string(200) },
  city: { type: T.string(80) },
  county: { type: T.string(80) },
  state: { type: T.state(), default: 'GA' },
  zip: { type: T.zip() },
  date_of_birth: { type: T.date() },
  turning_65: { type: T.month() },
  medicare_a_effective: { type: T.date() },
  medicare_b_effective: { type: T.date() },
  current_coverage: { type: T.text(1000) },
  stage: { type: T.enum(k(C.STAGES)), default: 'new' },
  source: { type: T.string(60) },
  topic: { type: T.enum(k(C.TOPICS)) },
  preferred_contact: { type: T.enum(k(C.PREFERRED_CONTACT)) },
  preferred_time: { type: T.string(120) },
  meeting_type: { type: T.enum(k(C.MEETING_TYPES)) },
  tags: { type: T.tags() },
  assigned_user_id: { type: T.id() },
};

const SORTS = {
  name: 'c.last_name COLLATE NOCASE {dir}, c.first_name COLLATE NOCASE {dir}',
  created: 'c.created_at {dir}',
  updated: 'c.updated_at {dir}',
  stage: `CASE c.stage ${C.STAGES.map(([s], i) => `WHEN '${s}' THEN ${i}`).join(' ')} END {dir}, c.updated_at DESC`,
  turning_65: 'c.turning_65 IS NULL, c.turning_65 {dir}',
  last_contacted: 'last_contacted_at IS NULL, last_contacted_at {dir}',
};

const LAST_CONTACTED_SQL = `(SELECT MAX(a.occurred_at) FROM activities a WHERE a.contact_id = c.id AND a.deleted_at IS NULL AND a.type IN ('call','email','text','meeting'))`;
const AGENT_LIST_MAX = 100;
const isAdminUser = (r) => r.user.role === 'admin';
/** Page-size cap: agents get smaller pages so bulk scraping is slow and visible. */
const listMax = (r, adminMax) => (isAdminUser(r) ? adminMax : Math.min(adminMax, AGENT_LIST_MAX));
const ACTIVITY_LOCK_MS = 24 * 3600e3;
const ACTIVITY_LOCKED_FIELDS = ['type', 'recorded', 'occurred_at', 'direction'];
const SOA_EVIDENCE_FIELDS = ['signed_at', 'signature_method', 'products', 'appointment_id'];

function soaForAppointment(db, appt) {
  if (appt.soa_id) {
    const s = db.prepare('SELECT * FROM scope_of_appointments WHERE id = ?').get(appt.soa_id);
    if (s) return s;
  }
  return db.prepare('SELECT * FROM scope_of_appointments WHERE appointment_id = ? ORDER BY signed_at DESC LIMIT 1').get(appt.id) || null;
}

function decorateAppointment(db, appt) {
  const soa = soaForAppointment(db, appt);
  return { ...appt, soa: soa ? { id: soa.id, signed_at: soa.signed_at, signature_method: soa.signature_method, products: JSON.parse(soa.products) } : null, compliance: soaCompliance(appt, soa) };
}

function decorateSoa(s) { return { ...s, products: JSON.parse(s.products), valid_until: permissionExpiresAt(s.signed_at) }; }

function validateDob(v) {
  if (v.date_of_birth) {
    if (v.date_of_birth > localDate()) fail(400, 'validation', { errors: { date_of_birth: 'Date of birth cannot be in the future.' } });
    v.turning_65 = turning65FromDob(v.date_of_birth);
  }
}

function registerRecordRoutes(router, ctx) {
  const { db } = ctx;

  const loadContact = (id) => {
    const c = mustGet(db, 'contacts', id, 'contact');
    if (c.deleted_at) fail(404, 'not_found', { message: 'That contact was permanently deleted.' });
    return c;
  };
  /** Audit a bulk read: what was listed and how many rows, never the search text or results. */
  const auditList = (r, entity, count, filterKeys) => auditR(db, r, 'list', entity, null,
    `count=${count}${filterKeys.length ? `; filters: ${filterKeys.join(', ')}` : ''}`);
  const usedFilters = (q, keys) => keys.filter((key) => q.get(key));

  // ---------------- Contacts ----------------
  router.get('/contacts', (r) => {
    const q = r.query;
    const where = [];
    const p = {};
    const archived = q.get('archived') || '0';
    if (!['0', '1', 'all'].includes(archived)) fail(400, 'bad_request', { message: 'Unknown archived filter.' });
    if (archived === 'all' && !isAdminUser(r)) fail(403, 'forbidden', { message: 'Only admins can list active and archived contacts together.' });
    where.push('c.deleted_at IS NULL');
    if (archived === '0') where.push('c.archived_at IS NULL');
    else if (archived === '1') where.push('c.archived_at IS NOT NULL');
    const term = (q.get('q') || '').trim().slice(0, 100);
    if (term) {
      p.term = `%${likeEscape(term)}%`;
      p.nterm = `%${likeEscape(normText(term) || '')}%`;
      const parts = ["crm_norm(c.first_name || ' ' || c.last_name) LIKE :nterm ESCAPE '\\'", "crm_norm(c.preferred_name) LIKE :nterm ESCAPE '\\'","c.first_name LIKE :term ESCAPE '\\'", "c.last_name LIKE :term ESCAPE '\\'", "(c.first_name || ' ' || c.last_name) LIKE :term ESCAPE '\\'",
        "c.preferred_name LIKE :term ESCAPE '\\'", "c.email LIKE :term ESCAPE '\\'", "c.zip LIKE :term ESCAPE '\\'"];
      const digits = term.replace(/\D/g, '');
      if (digits.length >= 3 && /^[\d\s().+-]+$/.test(term)) { p.digits = `%${digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits}%`; parts.push('c.phone LIKE :digits'); }
      where.push(`(${parts.join(' OR ')})`);
    }
    const stage = q.get('stage');
    if (stage && k(C.STAGES).includes(stage)) { where.push('c.stage = :stage'); p.stage = stage; }
    const topic = q.get('topic');
    if (topic && k(C.TOPICS).includes(topic)) { where.push('c.topic = :topic'); p.topic = topic; }
    const assigned = q.get('assigned');
    if (assigned === 'me') { where.push('c.assigned_user_id = :me'); p.me = r.user.id; } else if (assigned === 'none') where.push('c.assigned_user_id IS NULL');
    else if (assigned && /^\d+$/.test(assigned)) { where.push('c.assigned_user_id = :assigned'); p.assigned = Number(assigned); }
    const dnc = q.get('dnc');
    if (dnc === '1') where.push('c.do_not_contact = 1'); else if (dnc === '0') where.push('c.do_not_contact = 0');
    const from = q.get('t65_from');
    const to = q.get('t65_to');
    if (from && /^\d{4}-\d{2}$/.test(from)) { where.push('c.turning_65 >= :t65from'); p.t65from = from; }
    if (to && /^\d{4}-\d{2}$/.test(to)) { where.push('c.turning_65 <= :t65to'); p.t65to = to; }
    if (q.get('sort') && !Object.hasOwn(SORTS, q.get('sort'))) fail(400, 'bad_request', { message: 'Unknown sort.' });
    const sortKey = q.get('sort') || 'updated';
    const dir = q.get('dir') === 'asc' ? 'ASC' : (q.get('dir') === 'desc' ? 'DESC' : (sortKey === 'name' || sortKey === 'stage' || sortKey === 'turning_65' ? 'ASC' : 'DESC'));
    const { page, perPage, offset } = paging(q, { max: listMax(r, 500), def: 25 });
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM contacts c ${whereSql}`).get(p).n;
    const items = db.prepare(`SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.phone, c.email, c.zip, c.city, c.stage, c.topic, c.source,
        c.turning_65, c.do_not_contact, c.archived_at, c.created_at, c.updated_at, c.assigned_user_id, c.preferred_contact, c.tags,
        u.name AS assigned_name, ${LAST_CONTACTED_SQL} AS last_contacted_at
      FROM contacts c LEFT JOIN users u ON u.id = c.assigned_user_id ${whereSql}
      ORDER BY ${SORTS[sortKey].replace(/\{dir\}/g, dir)} LIMIT :limit OFFSET :offset`).all({ ...p, limit: perPage, offset });
    auditList(r, 'contacts', items.length, usedFilters(q, ['q', 'stage', 'topic', 'assigned', 'dnc', 'archived', 't65_from', 't65_to', 'sort', 'page']));
    return { items, total, page, per_page: perPage };
  });

  router.post('/contacts', (r) => {
    const v = check(contactSchema, r.body);
    validateDob(v);
    if (v.assigned_user_id && !userExists(db, v.assigned_user_id)) fail(400, 'validation', { errors: { assigned_user_id: 'Choose a valid user.' } });
    if (!r.body.allow_duplicate) {
      const found = S.findDuplicate(db, v.phone, v.email);
      if (found) fail(409, 'duplicate', { contact_id: found.contact.id, name: S.contactName(found.contact), message: 'A contact with this phone number or email already exists.' });
    }
    const now = S.nowIso();
    const id = tx(db, () => {
      const newId = insert(db, 'contacts', { ...v, source: v.source || 'manual', assigned_user_id: v.assigned_user_id || r.user.id, created_at: now, updated_at: now });
      S.addActivity(db, { contactId: newId, type: 'system', userId: r.user.id, body: `Contact created by ${r.user.name}.` });
      auditR(db, r, 'create', 'contact', newId);
      return newId;
    });
    return created({ id });
  });

  router.get('/contacts/:id', (r) => {
    const c = loadContact(r.params.id);
    const assigned = c.assigned_user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(c.assigned_user_id) : null;
    const admin = isAdminUser(r);
    const revs = admin ? db.prepare(`SELECT ar.*, u.name AS user_name FROM activity_revisions ar LEFT JOIN users u ON u.id = ar.user_id
      WHERE ar.contact_id = ? ORDER BY ar.at`).all(c.id) : [];
    const activities = db.prepare(`SELECT a.*, u.name AS user_name, du.name AS deleted_by_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN users du ON du.id = a.deleted_by
      WHERE a.contact_id = ? ${admin ? '' : 'AND a.deleted_at IS NULL'} ORDER BY a.occurred_at DESC, a.id DESC LIMIT 500`).all(c.id)
      .map((a) => ({
        ...a, meta: a.meta ? JSON.parse(a.meta) : null,
        editable: !a.deleted_at && C.MANUAL_ACTIVITY_TYPES.includes(a.type) && (admin || a.user_id === r.user.id),
        locked_fields: !admin && Date.now() - Date.parse(a.created_at) > ACTIVITY_LOCK_MS ? ACTIVITY_LOCKED_FIELDS : [],
        revisions: admin ? revs.filter((x) => x.activity_id === a.id).map((x) => ({ ...x, old_values: JSON.parse(x.old_values) })) : undefined,
      }));
    const tasks = db.prepare(`SELECT t.*, u.name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_user_id
      WHERE t.contact_id = ? ORDER BY t.done_at IS NOT NULL, t.due_at IS NULL, t.due_at`).all(c.id);
    const appointments = db.prepare('SELECT * FROM appointments WHERE contact_id = ? ORDER BY starts_at DESC').all(c.id).map((a) => decorateAppointment(db, a));
    const soas = db.prepare('SELECT * FROM scope_of_appointments WHERE contact_id = ? ORDER BY signed_at DESC').all(c.id).map(decorateSoa);
    const policies = db.prepare('SELECT * FROM policies WHERE contact_id = ? ORDER BY effective_date DESC, id DESC').all(c.id);
    const consentRows = db.prepare(`SELECT cs.*, u.name AS recorded_by FROM consents cs LEFT JOIN users u ON u.id = cs.recorded_by_user_id
      WHERE cs.contact_id = ? ORDER BY cs.captured_at DESC, cs.id DESC`).all(c.id);
    const consents = consentRows.map((x) => ({ ...x, pending_review: S.isPendingConsent(consentRows, x) }));
    const requests = db.prepare('SELECT * FROM contact_requests WHERE contact_id = ? ORDER BY requested_at DESC').all(c.id);
    auditR(db, r, 'view', 'contact', c.id);
    const lastRequest = requests[0];
    const permission = lastRequest ? {
      requested_at: lastRequest.requested_at, expires_at: permissionExpiresAt(lastRequest.requested_at),
      expired: Date.parse(permissionExpiresAt(lastRequest.requested_at)) < Date.now(),
    } : null;
    return {
      contact_permission: permission,
      contact: { ...c, assigned_name: assigned ? assigned.name : null },
      consent_state: S.consentState(db, c), activities, tasks, appointments, soas, policies, consents, contact_requests: requests,
    };
  });

  router.patch('/contacts/:id', (r) => {
    const c = loadContact(r.params.id);
    const v = check(contactSchema, r.body, { partial: true });
    validateDob(v);
    if (v.assigned_user_id && !userExists(db, v.assigned_user_id)) fail(400, 'validation', { errors: { assigned_user_id: 'Choose a valid user.' } });
    const newStage = v.stage;
    delete v.stage;
    const changed = changedFields(c, v);
    tx(db, () => {
      if (changed.length) update(db, 'contacts', c.id, { ...Object.fromEntries(changed.map((f) => [f, v[f]])), updated_at: S.nowIso() });
      if (newStage && newStage !== c.stage) { S.changeStage(db, c, newStage, { user: r.user }); changed.push('stage'); }
      if (changed.length) auditR(db, r, 'update', 'contact', c.id, `fields: ${changed.join(', ')}`);
    });
    return { ok: true, changed };
  });

  router.post('/contacts/:id/stage', (r) => {
    const c = loadContact(r.params.id);
    const v = check({ stage: { type: T.enum(k(C.STAGES)), required: true, label: 'Stage' } }, r.body);
    tx(db, () => {
      if (S.changeStage(db, c, v.stage, { user: r.user })) auditR(db, r, 'stage_change', 'contact', c.id, `to ${v.stage}`);
    });
    return { ok: true, stage: c.stage };
  });

  router.post('/contacts/:id/archive', (r) => {
    const c = loadContact(r.params.id);
    if (!c.archived_at) {
      tx(db, () => {
        update(db, 'contacts', c.id, { archived_at: S.nowIso(), updated_at: S.nowIso() });
        S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id, body: `Archived by ${r.user.name}.` });
        auditR(db, r, 'archive', 'contact', c.id);
      });
    }
    return { ok: true };
  });

  router.post('/contacts/:id/unarchive', (r) => {
    const c = loadContact(r.params.id);
    if (c.archived_at) {
      tx(db, () => {
        update(db, 'contacts', c.id, { archived_at: null, updated_at: S.nowIso() });
        S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id, body: `Restored from archive by ${r.user.name}.` });
        auditR(db, r, 'unarchive', 'contact', c.id);
      });
    }
    return { ok: true };
  });

  // Permanent delete. Consent, opt-out (suppression), website-request and audit records are append-only
  // compliance evidence, so the contact row is anonymized instead of removed: personal details are
  // cleared everywhere, working records (timeline, tasks, appointments, SOAs, policies) are deleted,
  // and the hashed suppression list keeps any opt-out in force if the person is ever re-added.
  router.delete('/contacts/:id', (r) => {
    const c = loadContact(r.params.id);
    const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (norm(r.body.confirm_name) !== norm(S.contactName(c))) {
      fail(400, 'validation', { errors: { confirm_name: 'Type the contact’s full name exactly as shown to confirm.' } });
    }
    tx(db, () => {
      const counts = ['activities', 'tasks', 'appointments', 'scope_of_appointments', 'policies']
        .map((t) => `${t}=${db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE contact_id = ?`).get(c.id).n}`);
      db.prepare('UPDATE appointments SET soa_id = NULL WHERE contact_id = ?').run(c.id);
      for (const t of ['scope_of_appointments', 'appointments', 'policies', 'tasks', 'activities']) db.prepare(`DELETE FROM ${t} WHERE contact_id = ?`).run(c.id);
      db.prepare('DELETE FROM activity_revisions WHERE contact_id = ?').run(c.id);
      db.prepare(`UPDATE consents SET phone = NULL, email = NULL, ip = NULL, user_agent = NULL, form_id = NULL, source_page = NULL WHERE contact_id = ?`).run(c.id);
      db.prepare(`UPDATE contact_requests SET phone = NULL, email = NULL, ip = NULL, user_agent = NULL, origin = NULL, referer = NULL,
        submitted_name = NULL, source_page = NULL WHERE contact_id = ?`).run(c.id);
      const now = S.nowIso();
      update(db, 'contacts', c.id, {
        first_name: 'Deleted', last_name: `contact #${c.id}`, preferred_name: null, phone: null, email: null, address: null, city: null, county: null,
        zip: null, date_of_birth: null, turning_65: null, medicare_a_effective: null, medicare_b_effective: null, current_coverage: null,
        preferred_time: null, tags: null, dnc_reason: null, source: null, archived_at: c.archived_at || now, deleted_at: now, updated_at: now,
      });
      auditR(db, r, 'delete', 'contact', c.id, `permanent delete (anonymized); removed ${counts.join(', ')}; consent and audit history kept`);
    });
    return { ok: true };
  }, admin);

  router.post('/contacts/:id/dnc', (r) => {
    const c = loadContact(r.params.id);
    const v = check({ do_not_contact: { type: T.bool(), required: true }, reason: { type: T.string(300) } }, r.body);
    if (!v.do_not_contact && c.do_not_contact) {
      if (!isAdminUser(r)) fail(403, 'forbidden', { message: 'Only an admin can remove the do-not-contact flag.' });
      if (!v.reason || v.reason.length < 5) fail(400, 'validation', { errors: { reason: 'Please record why (at least 5 characters).' } });
    }
    if (Boolean(v.do_not_contact) !== Boolean(c.do_not_contact)) {
      tx(db, () => {
        S.setDnc(db, c, Boolean(v.do_not_contact), { reason: v.reason, user: r.user, ip: r.ip });
        auditR(db, r, v.do_not_contact ? 'dnc_on' : 'dnc_off', 'contact', c.id);
      });
    }
    return { ok: true };
  });

  router.post('/contact-requests/:id/review', (r) => {
    const cr = mustGet(db, 'contact_requests', r.params.id, 'request');
    db.prepare('UPDATE contact_requests SET dnc_reviewed_at = ?, reviewed_at = ?, reviewed_by_user_id = ? WHERE id = ?').run(S.nowIso(), S.nowIso(), r.user.id, cr.id);
    auditR(db, r, 'dnc_request_reviewed', 'contact', cr.contact_id);
    return { ok: true };
  });

  // ---------------- Activities ----------------
  const activitySchema = {
    type: { type: T.enum(C.MANUAL_ACTIVITY_TYPES), required: true, label: 'Type' },
    direction: { type: T.enum(['in', 'out']) },
    body: { type: T.text(5000) },
    occurred_at: { type: T.datetime() },
    recorded: { type: T.bool() },
    duration_min: { type: T.int(0, 1440) },
  };

  router.post('/contacts/:id/activities', (r) => {
    const c = loadContact(r.params.id);
    const v = check(activitySchema, r.body);
    const override = typeof r.body.override_reason === 'string' ? r.body.override_reason.trim().slice(0, 500) : '';
    if (v.type === 'note' && !v.body) fail(400, 'validation', { errors: { body: 'Please write the note.' } });
    if (v.type !== 'call') { v.recorded = null; v.duration_min = v.type === 'meeting' ? v.duration_min : null; }
    const direction = v.type === 'note' ? null : (v.direction || 'out');

    // Server-side do-not-contact / text-consent enforcement for outbound contact.
    const outbound = direction === 'out' && ['call', 'text', 'email'].includes(v.type);
    let overrideFor = null;
    if (outbound && c.do_not_contact) overrideFor = 'dnc';
    else if (outbound && v.type === 'text' && !S.consentState(db, c).text.granted) overrideFor = 'no_text_consent';
    if (overrideFor && override.length < 5) {
      fail(409, overrideFor, {
        needs_override: true,
        message: overrideFor === 'dnc'
          ? 'This person is marked DO NOT CONTACT. Outbound calls, texts and emails are blocked. If you must log one (for example, returning their call), give a reason.'
          : 'There is no current text-message consent for this number. Get consent first, or give a reason for logging this text.',
      });
    }
    let completedTasks = 0;
    const id = tx(db, () => {
      const aid = S.addActivity(db, { contactId: c.id, type: v.type, direction, body: v.body,
        occurredAt: v.occurred_at, userId: r.user.id, recorded: v.recorded, durationMin: v.duration_min,
        meta: overrideFor ? { override: overrideFor, override_reason: override } : null });
      if (overrideFor) {
        S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id,
          body: `${overrideFor === 'dnc' ? 'Do-not-contact' : 'Missing text consent'} overridden by ${r.user.name} for an outbound ${v.type}. Reason: ${override}` });
        auditR(db, r, 'dnc_override', 'contact', c.id, `${overrideFor}; activity=${aid}`);
      }
      if (C.CONTACT_ACTIVITY_TYPES.includes(v.type) && !c.do_not_contact) S.advanceStage(db, c, 'contacted', r.user, `after logging a ${v.type}`);
      // Reaching out completes the open website call-back task.
      completedTasks = outbound ? S.completeCallbacks(db, c.id, `Completed automatically when ${r.user.name} logged an outbound ${v.type}.`) : 0;
      auditR(db, r, 'create', 'activity', aid, `type=${v.type}; contact=${c.id}${completedTasks ? `; completed ${completedTasks} call-back task(s)` : ''}`);
      return aid;
    });
    return created({ id, completed_tasks: completedTasks });
  });

  function editableActivity(r) {
    const a = mustGet(db, 'activities', r.params.id, 'activity');
    if (a.deleted_at) fail(404, 'not_found', { message: 'That entry was deleted.' });
    if (!C.MANUAL_ACTIVITY_TYPES.includes(a.type)) fail(403, 'immutable', { message: 'Website and system entries cannot be changed.' });
    if (r.user.role !== 'admin' && a.user_id !== r.user.id) fail(403, 'forbidden', { message: 'Only the person who logged this entry (or an admin) can change it.' });
    return a;
  }

  function saveRevision(a, action, fields, r) {
    const old = {};
    for (const f of fields) old[f] = a[f];
    db.prepare('INSERT INTO activity_revisions (activity_id, contact_id, action, old_values, user_id, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, a.contact_id, action, JSON.stringify(old), r.user.id, S.nowIso());
  }

  router.patch('/activities/:id', (r) => {
    const a = editableActivity(r);
    const v = check(activitySchema, r.body, { partial: true });
    const changed = changedFields(a, v);
    if (!isAdminUser(r) && Date.now() - Date.parse(a.created_at) > ACTIVITY_LOCK_MS) {
      const locked = changed.filter((f) => ACTIVITY_LOCKED_FIELDS.includes(f));
      if (locked.length) fail(403, 'immutable', { message: `After 24 hours only an admin can change: ${locked.join(', ')}.` });
    }
    if (changed.length) {
      tx(db, () => {
        saveRevision(a, 'edit', changed, r);
        update(db, 'activities', a.id, { ...Object.fromEntries(changed.map((f) => [f, v[f]])), updated_at: S.nowIso() });
        auditR(db, r, 'update', 'activity', a.id, `fields: ${changed.join(', ')}`);
      });
    }
    return { ok: true };
  });

  // Agents: soft delete (hidden, kept for admins). Admins: removed, with the old values kept in revisions.
  router.delete('/activities/:id', (r) => {
    const a = editableActivity(r);
    tx(db, () => {
      saveRevision(a, 'delete', ['type', 'direction', 'body', 'occurred_at', 'recorded', 'duration_min', 'user_id'], r);
      if (isAdminUser(r) && r.body && r.body.hard === true) db.prepare('DELETE FROM activities WHERE id = ?').run(a.id);
      else db.prepare('UPDATE activities SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(S.nowIso(), r.user.id, a.id);
      auditR(db, r, 'delete', 'activity', a.id, `type=${a.type}; contact=${a.contact_id}; ${isAdminUser(r) && r.body && r.body.hard === true ? 'hard' : 'soft'}`);
    });
    return { ok: true };
  });

  // ---------------- Tasks ----------------
  const taskSchema = {
    title: { type: T.string(200), required: true, label: 'Title' },
    contact_id: { type: T.id() },
    due_at: { type: T.datetime() },
    assigned_user_id: { type: T.id() },
    priority: { type: T.enum(k(C.TASK_PRIORITIES)), default: 'normal' },
    notes: { type: T.text(2000) },
  };

  router.get('/tasks', (r) => {
    const q = r.query;
    const where = [];
    const p = {};
    if (q.get('scope') === 'mine') { where.push('(t.assigned_user_id = :me OR t.assigned_user_id IS NULL)'); p.me = r.user.id; }
    const status = q.get('status') || 'open';
    if (status === 'open') where.push('t.done_at IS NULL'); else if (status === 'done') where.push('t.done_at IS NOT NULL');
    if (q.get('contact_id')) { where.push('t.contact_id = :cid'); p.cid = Number(q.get('contact_id')) || 0; }
    const { perPage, offset, page } = paging(q, { max: 500, def: 200 });
    const items = db.prepare(`SELECT t.*, u.name AS assigned_name, c.first_name, c.last_name, c.phone, c.do_not_contact
      FROM tasks t LEFT JOIN users u ON u.id = t.assigned_user_id LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE (t.contact_id IS NULL OR (c.archived_at IS NULL AND c.deleted_at IS NULL)) ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY t.done_at IS NOT NULL, ${status === 'done' ? 't.done_at DESC' : 't.due_at IS NULL, t.due_at'}, t.id LIMIT :limit OFFSET :offset`).all({ ...p, limit: perPage, offset });
    return { items, page, per_page: perPage };
  });

  function checkTaskRefs(v) {
    if (v.contact_id) loadContact(v.contact_id);
    if (v.assigned_user_id && !userExists(db, v.assigned_user_id)) fail(400, 'validation', { errors: { assigned_user_id: 'Choose a valid user.' } });
  }

  router.post('/tasks', (r) => {
    const v = check(taskSchema, r.body);
    checkTaskRefs(v);
    const now = S.nowIso();
    const id = insert(db, 'tasks', { ...v, assigned_user_id: v.assigned_user_id || r.user.id, created_by: r.user.id, created_at: now, updated_at: now });
    auditR(db, r, 'create', 'task', id, v.contact_id ? `contact=${v.contact_id}` : null);
    return created({ id });
  });

  router.patch('/tasks/:id', (r) => {
    const t = mustGet(db, 'tasks', r.params.id, 'task');
    const v = check(taskSchema, r.body, { partial: true });
    checkTaskRefs(v);
    const changed = changedFields(t, v);
    if (changed.length) {
      update(db, 'tasks', t.id, { ...v, updated_at: S.nowIso() });
      auditR(db, r, 'update', 'task', t.id, `fields: ${changed.join(', ')}`);
    }
    return { ok: true };
  });

  router.post('/tasks/:id/complete', (r) => {
    const t = mustGet(db, 'tasks', r.params.id, 'task');
    const done = r.body.done === undefined ? true : Boolean(r.body.done);
    update(db, 'tasks', t.id, { done_at: done ? S.nowIso() : null, updated_at: S.nowIso() });
    auditR(db, r, done ? 'complete' : 'reopen', 'task', t.id);
    return { ok: true };
  });

  router.delete('/tasks/:id', (r) => {
    const t = mustGet(db, 'tasks', r.params.id, 'task');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    auditR(db, r, 'delete', 'task', t.id);
    return { ok: true };
  });

  // ---------------- Appointments ----------------
  const apptSchema = {
    contact_id: { type: T.id(), required: true, label: 'Contact' },
    starts_at: { type: T.datetime(), required: true, label: 'Start time' },
    ends_at: { type: T.datetime() },
    type: { type: T.enum(k(C.MEETING_TYPES)), required: true, label: 'Meeting type' },
    location: { type: T.string(200) },
    status: { type: T.enum(k(C.APPOINTMENT_STATUS)), default: 'scheduled' },
    notes: { type: T.text(2000) },
    soa_id: { type: T.id() },
  };

  function checkAppt(v, contactId) {
    if (v.ends_at && v.starts_at && v.ends_at <= v.starts_at) fail(400, 'validation', { errors: { ends_at: 'End time must be after the start time.' } });
    if (v.soa_id) {
      const s = db.prepare('SELECT contact_id FROM scope_of_appointments WHERE id = ?').get(v.soa_id);
      if (!s || s.contact_id !== contactId) fail(400, 'validation', { errors: { soa_id: 'Choose an SOA for this contact.' } });
    }
  }

  router.get('/appointments', (r) => {
    const q = r.query;
    const where = [];
    const p = {};
    const from = q.get('from');
    const to = q.get('to');
    if (from && Number.isFinite(Date.parse(from))) { where.push('a.starts_at >= :from'); p.from = new Date(from).toISOString(); }
    if (to && Number.isFinite(Date.parse(to))) { where.push('a.starts_at < :to'); p.to = new Date(to).toISOString(); }
    if (q.get('contact_id')) { where.push('a.contact_id = :cid'); p.cid = Number(q.get('contact_id')) || 0; }
    const status = q.get('status');
    if (status && k(C.APPOINTMENT_STATUS).includes(status)) { where.push('a.status = :status'); p.status = status; }
    const items = db.prepare(`SELECT a.*, c.first_name, c.last_name, c.phone, c.do_not_contact FROM appointments a JOIN contacts c ON c.id = a.contact_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.starts_at LIMIT 1000`).all(p).map((a) => decorateAppointment(db, a));
    return { items };
  });

  router.post('/appointments', (r) => {
    const v = check(apptSchema, r.body);
    const c = loadContact(v.contact_id);
    checkAppt(v, c.id);
    const now = S.nowIso();
    const id = tx(db, () => {
      const aid = insert(db, 'appointments', { ...v, user_id: r.user.id, created_at: now, updated_at: now });
      if (v.soa_id) db.prepare('UPDATE scope_of_appointments SET appointment_id = ? WHERE id = ? AND appointment_id IS NULL').run(aid, v.soa_id);
      S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id, body: `Appointment scheduled: ${formatLocal(v.starts_at)} (${v.type}).` });
      if (v.status === 'scheduled') S.advanceStage(db, c, 'appointment_set', r.user, 'appointment scheduled');
      auditR(db, r, 'create', 'appointment', aid, `contact=${c.id}`);
      return aid;
    });
    return created({ id });
  });

  router.patch('/appointments/:id', (r) => {
    const a = mustGet(db, 'appointments', r.params.id, 'appointment');
    const v = check(apptSchema, r.body, { partial: true });
    delete v.contact_id;
    checkAppt({ starts_at: a.starts_at, ends_at: a.ends_at, ...v }, a.contact_id);
    const changed = changedFields(a, v);
    const linkedSoa = soaForAppointment(db, a);
    if (!isAdminUser(r) && changed.includes('soa_id') && (a.soa_id || linkedSoa)) {
      fail(403, 'forbidden', { message: 'Only an admin can change or remove the Scope of Appointment linked to an appointment.' });
    }
    if (changed.length) {
      tx(db, () => {
        const extra = {};
        if (v.status === 'cancelled' && a.status !== 'cancelled') extra.cancelled_at = S.nowIso();
        update(db, 'appointments', a.id, { ...Object.fromEntries(changed.map((f) => [f, v[f]])), ...extra, updated_at: S.nowIso() });
        // Every change to when/what/status is visible on the timeline (old -> new), never silent.
        const visible = ['starts_at', 'type', 'status', 'soa_id'].filter((f) => changed.includes(f));
        if (visible.length) {
          const fmt = (f, x) => (x === null || x === undefined ? 'none' : f === 'starts_at' ? formatLocal(x) : String(x));
          const diffs = visible.map((f) => `${f.replace('_', ' ')}: ${fmt(f, a[f])} → ${fmt(f, v[f])}`).join('; ');
          S.addActivity(db, { contactId: a.contact_id, type: 'system', userId: r.user.id,
            body: `Appointment originally ${formatLocal(a.starts_at)} changed by ${r.user.name}${linkedSoa ? ' (has an SOA on file)' : ''}: ${diffs}.` });
        }
        auditR(db, r, 'update', 'appointment', a.id, `fields: ${changed.join(', ')}`);
      });
    }
    return { ok: true };
  });

  // Only admins delete appointments; agents mark them cancelled or no-show so history is kept.
  router.delete('/appointments/:id', (r) => {
    const a = mustGet(db, 'appointments', r.params.id, 'appointment');
    tx(db, () => {
      S.addActivity(db, { contactId: a.contact_id, type: 'system', userId: r.user.id, body: `Appointment on ${formatLocal(a.starts_at)} (${a.type}, ${a.status}) deleted by ${r.user.name}.` });
      db.prepare('DELETE FROM appointments WHERE id = ?').run(a.id);
      auditR(db, r, 'delete', 'appointment', a.id, `contact=${a.contact_id}`);
    });
    return { ok: true };
  }, admin);

  // ---------------- Scope of Appointment ----------------
  const soaSchema = {
    contact_id: { type: T.id(), required: true, label: 'Contact' },
    appointment_id: { type: T.id() },
    products: { type: T.enumList(k(C.SOA_PRODUCTS)), required: true, requiredMessage: 'Choose at least one product the person agreed to discuss.' },
    signature_method: { type: T.enum(k(C.SOA_SIGNATURE_METHODS)), required: true, label: 'Signature method' },
    signed_at: { type: T.datetime(), required: true, label: 'Signed date and time' },
    initiated_by: { type: T.enum(k(C.SOA_INITIATED_BY)), required: true, label: 'Initiated by' },
    notes: { type: T.text(2000) },
  };

  function checkSoa(v, contactId) {
    if (v.signed_at && Date.parse(v.signed_at) > Date.now() + 5 * 60 * 1000) fail(400, 'validation', { errors: { signed_at: 'The signature time cannot be in the future.' } });
    if (v.appointment_id) {
      const a = db.prepare('SELECT contact_id FROM appointments WHERE id = ?').get(v.appointment_id);
      if (!a || a.contact_id !== contactId) fail(400, 'validation', { errors: { appointment_id: 'Choose an appointment for this contact.' } });
    }
  }

  router.get('/soas', (r) => {
    const p = {};
    let where = '';
    if (r.query.get('contact_id')) { where = 'WHERE s.contact_id = :cid'; p.cid = Number(r.query.get('contact_id')) || 0; }
    p.limit = listMax(r, 500);
    const items = db.prepare(`SELECT s.*, c.first_name, c.last_name, u.name AS created_by_name FROM scope_of_appointments s
      JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = s.created_by ${where} ORDER BY s.signed_at DESC LIMIT :limit`).all(p).map(decorateSoa);
    auditList(r, 'soas', items.length, usedFilters(r.query, ['contact_id']));
    return { items };
  });

  router.post('/soas', (r) => {
    const v = check(soaSchema, r.body);
    const c = loadContact(v.contact_id);
    checkSoa(v, c.id);
    const now = S.nowIso();
    const id = tx(db, () => {
      const sid = insert(db, 'scope_of_appointments', { ...v, products: JSON.stringify(v.products), created_by: r.user.id, created_at: now, updated_at: now });
      if (v.appointment_id) db.prepare('UPDATE appointments SET soa_id = ?, updated_at = ? WHERE id = ?').run(sid, now, v.appointment_id);
      S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id, body: `Scope of Appointment recorded (signed ${formatLocal(v.signed_at)}, ${v.signature_method.replace('_', ' ')}).` });
      auditR(db, r, 'create', 'soa', sid, `contact=${c.id}`);
      return sid;
    });
    return created({ id });
  });

  // SOA evidence (when/how it was signed, products, linked appointment) is fixed once recorded.
  // Agents may only edit notes / initiated-by; admins may correct evidence with a reason, and the
  // old -> new values go on the timeline and into the audit log.
  router.patch('/soas/:id', (r) => {
    const s = mustGet(db, 'scope_of_appointments', r.params.id, 'SOA');
    const v = check(soaSchema, r.body, { partial: true });
    delete v.contact_id;
    checkSoa(v, s.contact_id);
    if (v.products) v.products = JSON.stringify(v.products);
    const changed = changedFields(s, v);
    const evidence = changed.filter((f) => SOA_EVIDENCE_FIELDS.includes(f));
    const reason = typeof r.body.reason === 'string' ? r.body.reason.trim().slice(0, 300) : '';
    if (evidence.length && !isAdminUser(r)) fail(403, 'immutable', { message: `Only an admin can correct ${evidence.join(', ')} on a recorded SOA.` });
    if (evidence.length && reason.length < 5) fail(400, 'validation', { errors: { reason: 'Give a reason for correcting this SOA (at least 5 characters).' } });
    if (changed.length) {
      tx(db, () => {
        update(db, 'scope_of_appointments', s.id, { ...Object.fromEntries(changed.map((f) => [f, v[f]])), updated_at: S.nowIso() });
        if (changed.includes('appointment_id')) {
          if (s.appointment_id) db.prepare('UPDATE appointments SET soa_id = NULL WHERE id = ? AND soa_id = ?').run(s.appointment_id, s.id);
          if (v.appointment_id) db.prepare('UPDATE appointments SET soa_id = ? WHERE id = ?').run(s.id, v.appointment_id);
        }
        let diff = '';
        if (evidence.length) {
          diff = evidence.map((f) => `${f}: ${s[f] ?? 'none'} → ${v[f] ?? 'none'}`).join('; ');
          S.addActivity(db, { contactId: s.contact_id, type: 'system', userId: r.user.id,
            body: `Scope of Appointment #${s.id} corrected by ${r.user.name}. Reason: ${reason}. Changes: ${diff}` });
        }
        auditR(db, r, 'update', 'soa', s.id, `fields: ${changed.join(', ')}${diff ? `; ${diff}; reason: ${reason}` : ''}`);
      });
    }
    return { ok: true };
  });

  router.delete('/soas/:id', (r) => {
    const s = mustGet(db, 'scope_of_appointments', r.params.id, 'SOA');
    const reason = typeof r.body.reason === 'string' ? r.body.reason.trim() : '';
    if (reason.length < 5) fail(400, 'validation', { errors: { reason: 'Please give a reason (at least 5 characters). It is kept in the audit log.' } });
    tx(db, () => {
      db.prepare('DELETE FROM scope_of_appointments WHERE id = ?').run(s.id);
      S.addActivity(db, { contactId: s.contact_id, type: 'system', userId: r.user.id, body: `Scope of Appointment #${s.id} deleted by ${r.user.name}. Reason: ${reason.slice(0, 300)}` });
      auditR(db, r, 'delete', 'soa', s.id, `contact=${s.contact_id}; reason: ${reason.slice(0, 300)}`);
    });
    return { ok: true };
  }, admin);

  // ---------------- Policies ----------------
  const policySchema = {
    contact_id: { type: T.id(), required: true, label: 'Contact' },
    carrier: { type: T.enum(C.CARRIERS), required: true, label: 'Carrier' },
    plan_name: { type: T.string(150) },
    plan_type: { type: T.enum(C.PLAN_TYPES), required: true, label: 'Plan type' },
    plan_id: { type: { parse: (x) => { const s = String(x).trim().toUpperCase(); if (s.length > 30 || !/^[A-Z0-9-]+$/.test(s)) throw new Invalid('Use a plan ID like H1234-001.'); return s; } } },
    effective_date: { type: T.date() },
    end_date: { type: T.date() },
    status: { type: T.enum(k(C.POLICY_STATUS)), default: 'pending' },
    election_period: { type: T.enum(C.ELECTION_PERIODS) },
    application_submitted_at: { type: T.date() },
    application_number: { type: T.string(60) },
    premium: { type: T.money() },
    notes: { type: T.text(2000) },
  };

  function policyStage(db2, c, status, user) {
    if (status === 'active') S.advanceStage(db2, c, 'enrolled', user, 'policy active');
    else if (status === 'pending') S.advanceStage(db2, c, 'application_submitted', user, 'application submitted');
  }

  router.get('/policies', (r) => {
    const q = r.query;
    const where = [];
    const p = {};
    if (q.get('contact_id')) { where.push('p.contact_id = :cid'); p.cid = Number(q.get('contact_id')) || 0; }
    if (q.get('status') && k(C.POLICY_STATUS).includes(q.get('status'))) { where.push('p.status = :status'); p.status = q.get('status'); }
    if (q.get('carrier') && C.CARRIERS.includes(q.get('carrier'))) { where.push('p.carrier = :carrier'); p.carrier = q.get('carrier'); }
    p.limit = listMax(r, 1000);
    const items = db.prepare(`SELECT p.*, c.first_name, c.last_name FROM policies p JOIN contacts c ON c.id = p.contact_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.effective_date DESC, p.id DESC LIMIT :limit`).all(p);
    auditList(r, 'policies', items.length, usedFilters(q, ['contact_id', 'status', 'carrier']));
    return { items };
  });

  router.post('/policies', (r) => {
    const v = check(policySchema, r.body);
    const c = loadContact(v.contact_id);
    if (v.end_date && v.effective_date && v.end_date < v.effective_date) fail(400, 'validation', { errors: { end_date: 'End date must be after the effective date.' } });
    const now = S.nowIso();
    const id = tx(db, () => {
      const pid = insert(db, 'policies', { ...v, created_by: r.user.id, created_at: now, updated_at: now });
      S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id, body: `Policy added: ${v.carrier} ${v.plan_type}${v.plan_name ? ` — ${v.plan_name}` : ''} (${v.status}).` });
      policyStage(db, c, v.status, r.user);
      auditR(db, r, 'create', 'policy', pid, `contact=${c.id}`);
      return pid;
    });
    return created({ id });
  });

  router.patch('/policies/:id', (r) => {
    const pol = mustGet(db, 'policies', r.params.id, 'policy');
    const v = check(policySchema, r.body, { partial: true });
    delete v.contact_id;
    const eff = v.effective_date !== undefined ? v.effective_date : pol.effective_date;
    const end = v.end_date !== undefined ? v.end_date : pol.end_date;
    if (eff && end && end < eff) fail(400, 'validation', { errors: { end_date: 'End date must be after the effective date.' } });
    const changed = changedFields(pol, v);
    if (changed.length) {
      tx(db, () => {
        update(db, 'policies', pol.id, { ...v, updated_at: S.nowIso() });
        if (v.status && v.status !== pol.status) {
          S.addActivity(db, { contactId: pol.contact_id, type: 'system', userId: r.user.id, body: `Policy ${pol.carrier} ${pol.plan_type} status changed from ${pol.status} to ${v.status}.` });
          policyStage(db, loadContact(pol.contact_id), v.status, r.user);
        }
        auditR(db, r, 'update', 'policy', pol.id, `fields: ${changed.join(', ')}`);
      });
    }
    return { ok: true };
  });

  router.delete('/policies/:id', (r) => {
    const pol = mustGet(db, 'policies', r.params.id, 'policy');
    db.prepare('DELETE FROM policies WHERE id = ?').run(pol.id);
    auditR(db, r, 'delete', 'policy', pol.id, `contact=${pol.contact_id}`);
    return { ok: true };
  }, admin);

  // ---------------- Consents (append-only) ----------------
  router.get('/contacts/:id/consents', (r) => {
    const c = loadContact(r.params.id);
    const items = db.prepare(`SELECT cs.*, u.name AS recorded_by FROM consents cs LEFT JOIN users u ON u.id = cs.recorded_by_user_id
      WHERE cs.contact_id = ? ORDER BY cs.captured_at DESC, cs.id DESC`).all(c.id);
    return { items, state: S.consentState(db, c) };
  });

  router.post('/contacts/:id/consents', (r) => {
    const c = loadContact(r.params.id);
    const v = check({
      channels: { type: T.enumList(k(C.CONSENT_CHANNELS)), required: true, requiredMessage: 'Choose at least one channel.' },
      granted: { type: T.bool(), required: true, label: 'Granted or revoked' },
      source: { type: T.enum(['verbal', 'written', 'text_reply', 'manual']), required: true, label: 'How it was given' },
      consent_text: { type: T.text(2000) },
      notes: { type: T.text(1000) },
    }, r.body);
    if (v.granted && c.do_not_contact) fail(409, 'dnc', { message: 'This contact is marked do-not-contact. Remove that flag first if the person has asked to be contacted again.' });
    if (v.granted && !v.consent_text) fail(400, 'validation', { errors: { consent_text: 'Record what the person agreed to (the wording or a summary).' } });
    tx(db, () => {
      for (const ch of v.channels) {
        S.recordConsent(db, { contact_id: c.id, channel: ch, granted: v.granted, phone: c.phone, email: c.email, consent_text: v.consent_text, source: v.source,
          notes: v.notes, ip: r.ip, user_agent: null, recorded_by_user_id: r.user.id });
      }
      S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id, body: `Consent ${v.granted ? 'granted' : 'revoked'} (${v.source}): ${v.channels.join(', ')}.` });
      auditR(db, r, v.granted ? 'consent_grant' : 'consent_revoke', 'contact', c.id, `channels: ${v.channels.join(', ')}`);
    });
    return created({ ok: true, state: S.consentState(db, loadContact(c.id)) });
  });

  // Accept a website consent that was held for review (effective=0). Appends a new effective row.
  router.post('/consents/:id/accept', (r) => {
    const row = mustGet(db, 'consents', r.params.id, 'consent');
    const c = loadContact(row.contact_id);
    const all = db.prepare('SELECT * FROM consents WHERE contact_id = ?').all(c.id);
    if (!S.isPendingConsent(all, row)) fail(409, 'not_pending', { message: 'This consent is not waiting for review.' });
    if (c.do_not_contact) fail(409, 'dnc', { message: 'This contact is marked do-not-contact. Only an admin can remove that flag; do that first if appropriate.' });
    if (row.channel !== 'email' && row.phone !== c.phone) {
      fail(409, 'phone_mismatch', { message: `This consent covers a different number than the contact’s phone. Update the contact’s phone first if this is their number.` });
    }
    const note = typeof r.body.note === 'string' ? r.body.note.trim().slice(0, 500) : '';
    const id = tx(db, () => {
      const nid = S.recordConsent(db, {
        contact_id: c.id, channel: row.channel, granted: 1, effective: 1, phone: row.phone, email: row.email, text_version: row.text_version,
        consent_text: row.consent_text, source: row.source, form_id: row.form_id, source_page: row.source_page, ip: row.ip, user_agent: row.user_agent,
        notes: `Accepted after review by ${r.user.name}${note ? `: ${note}` : ''} (was held: ${row.review_reason || 'review'})`.slice(0, 1000),
        accepted_from_id: row.id, recorded_by_user_id: r.user.id,
      });
      S.addActivity(db, { contactId: c.id, type: 'system', userId: r.user.id, body: `Website ${row.channel} consent accepted after review by ${r.user.name}.` });
      auditR(db, r, 'consent_accept', 'contact', c.id, `consent=${row.id}; channel=${row.channel}`);
      return nid;
    });
    return created({ id, state: S.consentState(db, loadContact(c.id)) });
  });

  router.get('/consents', (r) => {
    const { page, perPage, offset } = paging(r.query, { max: listMax(r, 200), def: 50 });
    const items = db.prepare(`SELECT cs.id, cs.contact_id, cs.channel, cs.granted, cs.effective, cs.source, cs.text_version, cs.captured_at, cs.form_id, cs.notes,
        c.first_name, c.last_name, u.name AS recorded_by FROM consents cs JOIN contacts c ON c.id = cs.contact_id
        LEFT JOIN users u ON u.id = cs.recorded_by_user_id ORDER BY cs.captured_at DESC, cs.id DESC LIMIT ? OFFSET ?`).all(perPage, offset);
    const total = db.prepare('SELECT COUNT(*) AS n FROM consents').get().n;
    auditList(r, 'consents', items.length, usedFilters(r.query, ['page']));
    return { items, total, page, per_page: perPage };
  });
}

module.exports = { registerRecordRoutes, decorateAppointment, soaForAppointment, LAST_CONTACTED_SQL };
