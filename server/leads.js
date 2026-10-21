'use strict';
// POST /api/leads — public lead intake from the website forms.

const { T, validate, Invalid, EMAIL_RE } = require('./validate');
const { HttpError, readBody, parseForm, mediaType, sendJson, redirect, sendText, clientIp, originAllowed } = require('./http');
const { RateLimiter, ipKey } = require('./ratelimit');
const { tx, insert } = require('./db');
const S = require('./services');
const { nextBusinessDayAt } = require('./time');
const { WEB_CONSENT_TEXT, WEB_CONSENT_VERSION, TOPICS, keys } = require('./constants');

const BODY_LIMIT = 20 * 1024;
const MIN_FILL_MS = 3000;

const schema = {
  first_name: { type: T.string(60), required: true, requiredMessage: 'Please enter your first name.', label: 'First name' },
  last_name: { type: T.string(60), required: true, requiredMessage: 'Please enter your last name.', label: 'Last name' },
  phone: { type: { parse: (v) => { const s = String(v).trim(); const d = s.replace(/\D/g, ''); if (s.length > 30 || !(d.length === 10 || (d.length === 11 && d[0] === '1'))) throw new Invalid('Please enter a 10-digit phone number, like (404) 555-0123.'); return d.length === 11 ? d.slice(1) : d; } } },
  email: { type: { parse: (v) => { const s = String(v).trim().toLowerCase(); if (s.length > 120 || !EMAIL_RE.test(s)) throw new Invalid('Please check the email address. It should look like name@example.com.'); return s; } } },
  zip: { type: T.zip() },
  topic: { type: T.enum(keys(TOPICS)), default: 'other' },
  preferred_contact: { type: T.enum(['phone', 'email', 'text']), default: 'phone' },
  preferred_time: { type: T.string(120, 'Preferred time') },
  meeting_type: { type: T.enum(['phone', 'video', 'in-person']) },
  turning_65: { type: T.month() },
  message: { type: T.text(1500) },
  consent_texts: { type: T.enum(['yes'], 'Invalid value.') },
  form_id: { type: T.string(40) },
  source_page: { type: T.string(200) },
};

function createLeadHandler(ctx) {
  const { db, cfg, log } = ctx;
  // Two budgets per IP: accepted submissions (stored leads and bot traps), and validation failures
  // (higher, so people who make typos aren't locked out).
  const limiter = new RateLimiter([
    { windowMs: 10 * 60 * 1000, max: cfg.leadLimitShort },
    { windowMs: 24 * 60 * 60 * 1000, max: cfg.leadLimitDaily },
  ], { keyFn: ipKey, maxKeys: cfg.rateLimitMaxKeys });
  const failLimiter = new RateLimiter([{ windowMs: 10 * 60 * 1000, max: cfg.leadFailLimit }], { keyFn: ipKey, maxKeys: cfg.rateLimitMaxKeys });
  ctx.leadLimiter = limiter;
  ctx.timers.push(setInterval(() => failLimiter.prune(), 10 * 60 * 1000).unref());
  ctx.timers.push(setInterval(() => limiter.prune(), 10 * 60 * 1000).unref());

  return async function handleLead(req, res) {
    const type = mediaType(req);
    const isForm = type === 'application/x-www-form-urlencoded';
    if (type !== 'application/json' && !isForm) {
      sendJson(res, 415, { ok: false, error: 'unsupported_media_type' });
      return;
    }
    const success = () => (isForm ? redirect(res, 303, '/thank-you/') : sendJson(res, 201, { ok: true }));

    // Same-origin only. Browsers always send Origin and/or Sec-Fetch-Site on POST; a request with
    // neither is a non-browser client: accepted, but any consent it carries needs staff review.
    if (!originAllowed(req, cfg)) {
      if (isForm) sendText(res, 403, 'Forbidden');
      else sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const browserHeaders = Boolean(req.headers.origin || req.headers['sec-fetch-site']);

    let raw;
    try {
      raw = await readBody(req, BODY_LIMIT);
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) {
        if (isForm) sendText(res, 413, 'Your message was too long. Please shorten it, or call (404) 354-7597.');
        else sendJson(res, 413, { ok: false, error: 'too_large' });
        return;
      }
      throw err;
    }

    const ip = clientIp(req, cfg);
    if (limiter.blocked(ip) || failLimiter.blocked(ip)) {
      if (isForm) {
        sendText(res, 429, '<!doctype html><meta charset="utf-8"><title>Please wait</title><p>Too many requests from this device. Please wait a few minutes, or call Skip at <a href="tel:+14043547597">(404) 354-7597</a>.</p><p><a href="/">Back to the home page</a></p>', 'text/html; charset=utf-8', { 'Retry-After': '600' });
      } else {
        sendJson(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '600' });
      }
      return;
    }

    let input;
    if (isForm) input = parseForm(raw);
    else {
      try { input = JSON.parse(raw || '{}'); } catch { input = null; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { sendJson(res, 400, { ok: false, errors: { form: 'Invalid request.' } }); return; }
    }
    // Only accept scalar strings/numbers from the public form.
    const clean = {};
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'string' || typeof v === 'number') clean[k] = String(v);
    }

    // Bot traps: pretend success, store nothing.
    if ((clean.website || '').trim() !== '') { limiter.hit(ip); log.info('lead_trap', { reason: 'honeypot' }); success(); return; }
    const token = ctx.formTokens.verify(clean.form_token);
    if (token.valid && Date.now() - token.issuedAt < MIN_FILL_MS) { limiter.hit(ip); log.info('lead_trap', { reason: 'too_fast' }); success(); return; }
    const started = Number(clean.form_started_at);
    if (clean.form_started_at && Number.isFinite(started) && started > 0) {
      const elapsed = Date.now() - started;
      if (elapsed >= 0 && elapsed < MIN_FILL_MS) { limiter.hit(ip); log.info('lead_trap', { reason: 'too_fast' }); success(); return; }
    }

    const { values: v, errors } = validate(schema, clean);
    if (!errors.phone && !v.phone && !v.email) errors.phone = 'Please enter a phone number or an email address so Skip can reach you.';
    if (!errors.phone && v.consent_texts === 'yes' && !v.phone) errors.phone = "Please add a phone number if you'd like calls or texts.";
    if (!errors.preferred_contact && v.preferred_contact === 'text' && v.consent_texts !== 'yes') {
      errors.consent_texts = "Please check the consent box if you'd like text messages, or choose phone or email.";
    }
    if (Object.keys(errors).length) {
      failLimiter.hit(ip);
      if (isForm) redirect(res, 303, '/contact/?error=1#form-error');
      else sendJson(res, 400, { ok: false, errors });
      return;
    }

    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
    limiter.hit(ip);
    tx(db, () => storeLead(db, v, {
      ip, userAgent, origin: String(req.headers.origin || '').slice(0, 200) || null, referer: String(req.headers.referer || '').slice(0, 200) || null,
      verified: token.valid, verifyReason: token.reason, browserHeaders,
    }));
    success();
  };
}

/**
 * Persist an accepted website request.
 * Security model: anyone can type someone else's phone/email into a public form, so:
 *  - a request only attaches to an existing contact with the same phone/email AND the same name;
 *    otherwise a separate contact is created ("possible household member — review");
 *  - an attached request never changes the contact's details (topic/preferences live on the request);
 *  - web consent is effective automatically only when nothing about the request is doubtful;
 *    otherwise it is stored with effective=0 and a staff member must review and accept it.
 */
function storeLead(db, v, { ip = null, userAgent = null, origin = null, referer = null, verified = true, verifyReason = null, browserHeaders = true } = {}) {
  const now = S.nowIso();
  const submittedName = S.contactName(v);
  const candidates = S.findCandidates(db, v.phone, v.email);
  const named = candidates.find((x) => S.sameName(x.contact, v));
  let contact = named ? named.contact : null;
  const isNew = !contact;
  const household = isNew && candidates.length ? candidates[0] : null;
  const matchType = named ? named.matchType : (household ? 'household' : 'new');

  if (isNew) {
    const id = insert(db, 'contacts', {
      first_name: v.first_name, last_name: v.last_name, phone: v.phone, email: v.email, zip: v.zip, state: 'GA',
      turning_65: v.turning_65, stage: 'new', source: 'website', topic: v.topic, preferred_contact: v.preferred_contact,
      preferred_time: v.preferred_time, meeting_type: v.meeting_type, assigned_user_id: S.defaultAssignee(db),
      tags: household ? 'possible household member' : null, related_contact_id: household ? household.contact.id : null,
      created_at: now, updated_at: now,
    });
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (household) {
      const other = household.contact;
      S.addActivity(db, { contactId: id, type: 'system', body: `Possible household member — review. This request used the same ${household.matchType} as ${S.contactName(other)} (contact #${other.id}) but a different name, so a separate contact was created. Nothing on #${other.id} was changed.` });
      S.addActivity(db, { contactId: other.id, type: 'system', body: `Someone named “${submittedName}” sent a website request using this contact's ${household.matchType}. A separate contact (#${id}) was created for review; nothing here was changed.` });
    }
  }

  const lines = [`Website request (${v.form_id || 'form'}) from “${submittedName}”`];
  if (!verified) lines.push(`Unverified source (${verifyReason || 'no form token'}).`);
  if (v.message) lines.push(v.message);
  const activityId = S.addActivity(db, {
    contactId: contact.id, type: 'web_form', direction: 'in', body: lines.join('\n\n'),
    meta: { fields: { ...v }, beneficiary_initiated: true, ip, user_agent: userAgent, matched_existing: !isNew, match_type: matchType, verified_source: verified },
  });

  insert(db, 'contact_requests', {
    contact_id: contact.id, activity_id: activityId, requested_at: now, topic: v.topic, preferred_contact: v.preferred_contact,
    phone: v.phone, email: v.email, form_id: v.form_id, source_page: v.source_page, ip, user_agent: userAgent,
    while_dnc: contact.do_not_contact ? 1 : 0, origin, referer, match_type: matchType,
    verified: verified ? 1 : 0, submitted_name: submittedName.slice(0, 130),
  });

  if (v.consent_texts === 'yes') {
    const reasons = [];
    if (contact.do_not_contact) reasons.push('contact is marked do-not-contact');
    if (!isNew && contact.phone && contact.phone !== v.phone) reasons.push('submitted phone differs from the contact’s phone');
    if (matchType === 'email') reasons.push('matched by email only');
    if (household) reasons.push(`this ${household.matchType} is shared with another contact (possible household member)`);
    if (!verified) reasons.push(`unverified source (${verifyReason || 'no form token'})`);
    if (!browserHeaders) reasons.push('request had no browser Origin header');
    const consentIds = [];
    for (const channel of ['call', 'text', 'automated']) {
      const chReasons = [...reasons];
      const last = isNew ? null : db.prepare('SELECT granted FROM consents WHERE contact_id = ? AND channel = ? AND effective = 1 ORDER BY captured_at DESC, id DESC LIMIT 1').get(contact.id, channel);
      if (last && !last.granted) chReasons.push(`latest ${channel} entry is an opt-out`);
      else if (S.suppressedAt(db, { phone: v.phone }, channel)) chReasons.push(`this number previously opted out of ${channel}`);
      consentIds.push(S.recordConsent(db, {
        contact_id: contact.id, channel, granted: 1, effective: chReasons.length ? 0 : 1, review_reason: chReasons.join('; ') || null,
        phone: v.phone, text_version: WEB_CONSENT_VERSION, consent_text: WEB_CONSENT_TEXT, source: 'web_form',
        form_id: v.form_id, source_page: v.source_page, captured_at: now, ip, user_agent: userAgent,
      }));
    }
    const pending = db.prepare(`SELECT review_reason FROM consents WHERE id IN (${consentIds.join(',')}) AND effective = 0`).all();
    if (pending.length) {
      const why = [...new Set(pending.flatMap((p) => p.review_reason.split('; ')))].join('; ');
      S.addActivity(db, { contactId: contact.id, type: 'system', body: `Website consent needs review: ${why}. It is NOT in effect until a staff member accepts it (Consent tab).` });
    }
  }

  const archived = Boolean(contact.archived_at);
  if (!isNew && !archived && !contact.do_not_contact && (contact.stage === 'lost' || contact.stage === 'not_now')) {
    S.changeStage(db, contact, 'new', { note: 'new website request' });
  }
  if (contact.do_not_contact) {
    S.addActivity(db, { contactId: contact.id, type: 'system', body: 'This person is marked DO NOT CONTACT but sent a new website request. Review before reaching out.' });
  }

  const due = nextBusinessDayAt(new Date(), 10).toISOString(); // 10:00 AM Georgia time, next business day
  const assignee = S.activeAssignee(db, contact.assigned_user_id);
  const addTask = (title, notes, priority, kind) => insert(db, 'tasks', {
    contact_id: contact.id, title: title.slice(0, 200), due_at: due, assigned_user_id: assignee, priority, notes, kind, created_at: now, updated_at: now,
  });
  if (household) {
    addTask(`Possible household member — review ${submittedName}`, `Shares a ${household.matchType} with ${S.contactName(household.contact)} (contact #${household.contact.id}). Confirm who this is before calling.`, 'high', 'review');
  } else if (archived) {
    addTask('Archived contact sent a new request — review', 'The contact was left archived. Restore it if you will work with this person again.', 'normal', 'review');
  } else if (!S.openCallback(db, contact.id)) {
    addTask(`Call back ${submittedName}`, contact.do_not_contact ? 'Contact is marked do-not-contact. Review the request before calling.' : null, contact.do_not_contact ? 'low' : 'high', 'callback');
  } else {
    S.addActivity(db, { contactId: contact.id, type: 'system', body: 'An open call-back task already exists, so no new task was added.' });
  }
  S.audit(db, { action: 'lead_received', entity: 'contact', entityId: contact.id,
    summary: household ? `new contact; shares ${household.matchType} with contact ${household.contact.id}` : isNew ? 'new contact' : `matched existing contact by ${matchType}`, ip });
  return contact.id;
}

module.exports = { createLeadHandler, RateLimiter, storeLead, BODY_LIMIT, MIN_FILL_MS };
