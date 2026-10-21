'use strict';
// CRM API for statewide events and their RSVPs.

const E = require('../events');
const S = require('../services');
const { insert, update, tx } = require('../db');
const { toCsv } = require('../csv');
const { CSP_PUBLIC } = require('../http');
const { formatPhone } = require('../validate');
const { localDateTimeText, localDate } = require('../time');
const { fail, check, mustGet, auditR, changedFields, created } = require('./helpers');

const admin = { role: 'admin' };

function registerEventRoutes(router, ctx) {
  const { db } = ctx;
  const isAdmin = (r) => r.user.role === 'admin';
  const loadEvent = (id) => mustGet(db, 'events', id, 'event');

  function counts(eventId) {
    return db.prepare(`SELECT COUNT(*) AS rsvps, COALESCE(SUM(1 + guests), 0) AS people,
        COALESCE(SUM(CASE WHEN needs_accommodation IS NOT NULL AND needs_accommodation != '' THEN 1 ELSE 0 END), 0) AS accommodations
      FROM event_rsvps WHERE event_id = ? AND status = 'going'`).get(eventId);
  }
  function decorate(e, { full = false } = {}) {
    const c = E.checkEvent(e, { db });
    const out = { ...e, counts: counts(e.id), compliance: full ? c : { blockers: c.blockers.length, warnings: c.warnings.length, ok: c.ok } };
    return out;
  }

  router.get('/events', (r) => {
    const tab = r.query.get('tab') || 'upcoming';
    const now = new Date().toISOString();
    const where = {
      upcoming: "status IN ('published','cancelled') AND ends_at > :now",
      past: "status IN ('published','cancelled') AND ends_at <= :now",
      drafts: "status = 'draft'",
      all: '1 = 1',
    }[tab];
    if (!where) fail(400, 'bad_request', { message: 'Unknown tab.' });
    const order = tab === 'past' ? 'starts_at DESC' : 'starts_at IS NULL, starts_at';
    const items = db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY ${order} LIMIT 500`).all({ now }).map((e) => decorate(e));
    return { items };
  });

  router.post('/events/compliance-check', (r) => {
    const v = E.validateEvent(r.body, { partial: true }).values;
    const base = r.body.id ? db.prepare('SELECT * FROM events WHERE id = ?').get(Number(r.body.id)) : null;
    return E.checkEvent({ ...(base || {}), ...v, id: base ? base.id : 0 }, { db });
  });

  router.post('/events', (r) => {
    const v = check(E.eventSchema, r.body);
    if (v.starts_at && v.ends_at && v.ends_at <= v.starts_at) fail(400, 'validation', { errors: { ends_at: 'The end must be after the start.' } });
    const now = S.nowIso();
    const id = tx(db, () => {
      const nid = insert(db, 'events', { ...v, status: 'draft', created_by: r.user.id, updated_by: r.user.id, created_at: now, updated_at: now });
      update(db, 'events', nid, { slug: E.makeSlug(db, { ...v, id: nid }) });
      auditR(db, r, 'create', 'event', nid, `type=${v.event_type}`);
      return nid;
    });
    return created({ id });
  });

  router.get('/events/:id', (r) => {
    const e = loadEvent(r.params.id);
    return { event: decorate(e, { full: true }) };
  });

  router.patch('/events/:id', (r) => {
    const e = loadEvent(r.params.id);
    if (e.status === 'cancelled') fail(409, 'cancelled', { message: 'Cancelled events can’t be edited. Duplicate it to schedule a new date.' });
    // Agents edit only events that have never been public; anything that was published is admin-only.
    if ((e.status !== 'draft' || e.published_at) && !isAdmin(r)) fail(403, 'forbidden', { message: 'Only an admin can change an event that has been published.' });
    const v = check(E.eventSchema, r.body, { partial: true });
    const next = { ...e, ...v };
    if (next.starts_at && next.ends_at && next.ends_at <= next.starts_at) fail(400, 'validation', { errors: { ends_at: 'The end must be after the start.' } });
    if (e.status === 'published') {
      // Every public field is re-linted on each edit of a published event.
      const c = E.checkEvent(next, { db, purpose: Date.parse(e.starts_at) > Date.now() ? 'publish' : 'cancel' });
      if (c.blockers.length) fail(400, 'compliance', { message: 'This change would make the published event non-compliant.', blockers: c.blockers });
    }
    const changed = changedFields(e, v);
    if (changed.length) {
      tx(db, () => {
        const extra = {};
        if (!e.published_at && (changed.includes('title') || changed.includes('starts_at'))) extra.slug = E.makeSlug(db, next);
        update(db, 'events', e.id, { ...Object.fromEntries(changed.map((f) => [f, v[f]])), ...extra, updated_by: r.user.id, updated_at: S.nowIso() });
        auditR(db, r, 'update', 'event', e.id, `fields: ${changed.join(', ')}`);
      });
    }
    return { ok: true, changed };
  });

  router.post('/events/:id/publish', (r) => {
    const e = loadEvent(r.params.id);
    if (e.status !== 'draft') fail(409, 'not_draft', { message: 'Only a draft can be published.' });
    const c = E.checkEvent(e, { db });
    if (!c.ok) fail(400, 'compliance', { message: 'Fix the items in the compliance checklist before publishing.', blockers: c.blockers });
    const now = S.nowIso();
    tx(db, () => {
      const slug = e.published_at ? e.slug : E.makeSlug(db, e); // stable once published
      update(db, 'events', e.id, { status: 'published', slug, published_at: e.published_at || now, updated_by: r.user.id, updated_at: now });
      auditR(db, r, 'publish', 'event', e.id, c.warnings.length ? `warnings: ${c.warnings.map((w) => w.id).join(', ')}` : null);
    });
    return { ok: true, warnings: c.warnings };
  }, admin);

  router.post('/events/:id/unpublish', (r) => {
    const e = loadEvent(r.params.id);
    if (e.status !== 'published') fail(409, 'not_published', { message: 'This event isn’t published.' });
    update(db, 'events', e.id, { status: 'draft', public_cancel: 0, updated_by: r.user.id, updated_at: S.nowIso() });
    auditR(db, r, 'unpublish', 'event', e.id);
    return { ok: true };
  }, admin);

  router.post('/events/:id/cancel', (r) => {
    const e = loadEvent(r.params.id);
    if (e.status === 'cancelled') fail(409, 'cancelled', { message: 'This event is already cancelled.' });
    const reason = typeof r.body.reason === 'string' ? r.body.reason.trim().slice(0, 300) : '';
    if (reason.length < 5) fail(400, 'validation', { errors: { reason: 'Please give a short reason (it is shown on the public page).' } });
    // Cancelling a published event keeps it visible ("Cancelled" + reason), so the stored event and the
    // reason get the full publish lint. A draft that is cancelled never becomes public.
    const goesPublic = e.status === 'published';
    if (goesPublic) {
      const c = E.checkEvent({ ...e, cancel_reason: reason }, { db, purpose: 'cancel' });
      if (c.blockers.length) fail(400, 'compliance', { message: 'This event (or the cancellation reason) doesn’t pass the publishing checks, so it can’t be shown as cancelled. Unpublish it instead, or fix the wording.', blockers: c.blockers });
    }
    const now = S.nowIso();
    update(db, 'events', e.id, { status: 'cancelled', public_cancel: goesPublic ? 1 : 0, cancelled_at: now, cancel_reason: reason, updated_by: r.user.id, updated_at: now });
    auditR(db, r, 'cancel', 'event', e.id, 'reason recorded');
    const rsvps = db.prepare("SELECT id, first_name, last_name, phone, email, guests FROM event_rsvps WHERE event_id = ? AND status = 'going' ORDER BY last_name, first_name").all(e.id);
    return { ok: true, rsvps };
  }, admin);

  router.post('/events/:id/duplicate', (r) => {
    const e = loadEvent(r.params.id);
    const now = S.nowIso();
    const copy = {};
    for (const k of Object.keys(E.eventSchema)) copy[k] = e[k];
    copy.carrier_submitted = 0; // each new date must be submitted to the carriers again
    copy.carrier_refs = null;
    copy.gifts_ack = 0;
    copy.pairing_ack = 0;
    copy.title = `${e.title}`.slice(0, 90);
    const id = tx(db, () => {
      const nid = insert(db, 'events', { ...copy, status: 'draft', created_by: r.user.id, updated_by: r.user.id, created_at: now, updated_at: now });
      update(db, 'events', nid, { slug: E.makeSlug(db, { ...copy, id: nid }) });
      auditR(db, r, 'duplicate', 'event', nid, `from event ${e.id}`);
      return nid;
    });
    return created({ id });
  });

  router.delete('/events/:id', (r) => {
    const e = loadEvent(r.params.id);
    if (e.status !== 'draft' || e.published_at) fail(409, 'keep_record', { message: 'Published and cancelled events are kept for records and can’t be deleted. Cancel it instead.' });
    tx(db, () => {
      db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
      auditR(db, r, 'delete', 'event', e.id);
    });
    return { ok: true };
  }, admin);

  router.get('/events/:id/preview', (r) => {
    const e = loadEvent(r.params.id);
    if (!e.starts_at) fail(400, 'bad_request', { message: 'Set a start and end time to preview.' });
    r.res.setHeader('Content-Security-Policy', CSP_PUBLIC);
    auditR(db, r, 'preview', 'event', e.id);
    ctx.eventsPublic.preview(r.req, r.res, { ...e, ends_at: e.ends_at || e.starts_at });
    return undefined;
  });

  // ---------------- RSVPs ----------------
  const rsvpRows = (eventId) => db.prepare(`SELECT v.*, c.first_name AS contact_first, c.last_name AS contact_last, c.do_not_contact
    FROM event_rsvps v LEFT JOIN contacts c ON c.id = v.contact_id WHERE v.event_id = ? ORDER BY v.status, v.last_name COLLATE NOCASE, v.first_name COLLATE NOCASE`).all(eventId);

  router.get('/events/:id/rsvps', (r) => {
    const e = loadEvent(r.params.id);
    const items = rsvpRows(e.id).map((x) => ({ ...x, ip: undefined, user_agent: undefined }));
    auditR(db, r, 'list', 'event_rsvps', e.id, `count=${items.length}`);
    return { items, counts: counts(e.id) };
  });

  router.post('/event-rsvps/:id/cancel', (r) => {
    const v = mustGet(db, 'event_rsvps', r.params.id, 'RSVP');
    if (v.status !== 'cancelled') {
      update(db, 'event_rsvps', v.id, { status: 'cancelled', cancelled_at: S.nowIso() });
      auditR(db, r, 'rsvp_cancel', 'event', v.event_id, `rsvp=${v.id}`);
    }
    return { ok: true };
  }, admin);

  router.get('/events/:id/rsvps.csv', (r) => {
    const e = loadEvent(r.params.id);
    const rows = rsvpRows(e.id);
    const csv = toCsv([
      { key: 'first_name', label: 'First name' }, { key: 'last_name', label: 'Last name' },
      { key: 'phone', label: 'Phone', get: (x) => formatPhone(x.phone) }, { key: 'email', label: 'Email' },
      { key: 'guests', label: 'Guests' }, { key: 'needs_accommodation', label: 'Accommodation needs' },
      { key: 'contact_permission', label: 'OK to contact about plans', get: (x) => (x.contact_permission ? 'yes' : 'no') },
      { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Signed up (Eastern)', get: (x) => localDateTimeText(x.created_at) },
    ], rows);
    auditR(db, r, 'export', 'event_rsvps', e.id, `${rows.length} rows`);
    r.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rsvps-${e.slug || e.id}-${localDate()}.csv"`,
      'Content-Length': Buffer.byteLength(csv),
    });
    r.res.end(csv);
    return undefined;
  }, admin);
}

/** Upcoming published events (next `days` days) for the dashboard. */
function upcomingForDashboard(db, days = 14) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 864e5).toISOString();
  return db.prepare("SELECT * FROM events WHERE status = 'published' AND ends_at > ? AND starts_at < ? ORDER BY starts_at").all(now.toISOString(), until)
    .map((e) => {
      const c = E.checkEvent(e, { db });
      const n = db.prepare("SELECT COUNT(*) AS rsvps, COALESCE(SUM(1 + guests), 0) AS people FROM event_rsvps WHERE event_id = ? AND status = 'going'").get(e.id);
      return { id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, format: e.format, city: e.city, venue_name: e.venue_name, event_type: e.event_type, capacity: e.capacity,
        counts: n, warnings: c.warnings.map((w) => w.message) };
    });
}

module.exports = { registerEventRoutes, upcomingForDashboard };
