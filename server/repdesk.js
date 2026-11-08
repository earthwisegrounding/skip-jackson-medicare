'use strict';
// Forwards website requests to Skip's RepDesk desk (the CRM add-on run by Digital Doorway Marketing).
//
// Every accepted request is still recorded here first (storeLead), and a copy is queued in
// repdesk_outbox in the same transaction, so nothing is lost if RepDesk is down: the queue is retried
// with back-off until RepDesk takes it. If the CRM add-on is cancelled, RepDesk answers
// `crm_inactive` and the copy is marked refused; the request itself stays in this site's records.
//
// REPDESK_FORM_URL is the desk's private form address (https://…/inbound/<token>). It works like a
// password, so it lives in the server's environment file, never in this (public) repository.

const { TOPICS, MEETING_TYPES, WEB_CONSENT_TEXT, WEB_CONSENT_VERSION } = require('./constants');

const FORM_URL_RE = /^https:\/\/[^/\s]+\/inbound\/[A-Za-z0-9_-]{20,64}$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/inbound\/[A-Za-z0-9_-]{20,64}$/;
const label = (pairs, key) => (pairs.find(([k]) => k === key) || [])[1] || key;
const fmtPhone = (d) => (d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || '');

/** The form fields RepDesk's inbound address reads, built from a validated website request. */
function outboxPayload(v, { source = 'website', verified = true, verifyReason = null, submittedAt }) {
  const lines = [];
  if (v.message) lines.push(v.message);
  if (v.preferred_time) lines.push(`Best time to reach: ${v.preferred_time}`);
  if (v.meeting_type) lines.push(`Would like to meet by: ${label(MEETING_TYPES, v.meeting_type).toLowerCase()}`);
  if (v.turning_65) lines.push(`Turning 65: ${v.turning_65}`);
  if (v.consent_texts === 'yes') lines.push(`Agreed to calls and texts (consent wording ${WEB_CONSENT_VERSION}): “${WEB_CONSENT_TEXT}”`);
  lines.push(`${source === 'event' ? 'Event RSVP' : 'Website request'} (${v.form_id || 'form'}) on ${v.source_page || 'the website'}, sent ${submittedAt}.`);
  if (!verified) lines.push(`Unverified source (${verifyReason || 'no form token'}): check before relying on it.`);
  return {
    first_name: v.first_name, last_name: v.last_name, phone: fmtPhone(v.phone), email: v.email || '', zip: v.zip || '',
    topic: source === 'event' ? 'Event RSVP' : label(TOPICS, v.topic || 'other'),
    contact_method: v.preferred_contact || 'phone',
    // Sending a request is the person's permission to be contacted about it.
    contact_consent: 'yes',
    ...(v.consent_texts === 'yes' ? { sms_consent: 'yes' } : {}),
    message: lines.join('\n\n'),
  };
}

/** Queues a copy for RepDesk. Called inside storeLead's transaction. */
function queue(db, contactId, payload) {
  db.prepare('INSERT INTO repdesk_outbox (contact_id, payload, created_at) VALUES (?, ?, ?)').run(contactId, JSON.stringify(payload), new Date().toISOString());
}

function createRepdeskForwarder(ctx) {
  const { db, cfg, log } = ctx;
  const url = cfg.repdeskFormUrl;
  if (!url) return { enabled: false, flush: async () => {} };
  if (!FORM_URL_RE.test(url)) {
    log.error('repdesk_config', { error: 'REPDESK_FORM_URL is not a RepDesk form address; forwarding is off' });
    return { enabled: false, flush: async () => {} };
  }
  let busy = false;

  async function send(row) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(cfg.publicUrl ? { origin: cfg.publicUrl } : {}) },
      body: new URLSearchParams(JSON.parse(row.payload)).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  }

  async function flush() {
    if (busy) return;
    busy = true;
    try {
      const now = new Date().toISOString();
      const rows = db.prepare("SELECT * FROM repdesk_outbox WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 20").all(now);
      for (const row of rows) {
        let result;
        try { result = await send(row); } catch (err) { result = { status: 0, error: err.name === 'TimeoutError' ? 'timeout' : 'network error' }; }
        const at = new Date().toISOString();
        if (result.status === 200 && result.body && result.body.ok) {
          // Delivered: drop the personal details from the copy; the request itself stays in this site's records.
          db.prepare("UPDATE repdesk_outbox SET status = 'sent', sent_at = ?, payload = '{}', last_error = NULL WHERE id = ?").run(at, row.id);
          log.info('repdesk_sent', { outbox: row.id });
        } else if (result.status === 403 && result.body && result.body.error === 'crm_inactive') {
          db.prepare("UPDATE repdesk_outbox SET status = 'refused', last_error = 'crm_inactive' WHERE id = ?").run(row.id);
          log.info('repdesk_refused', { outbox: row.id, reason: 'crm_inactive' });
        } else {
          const attempts = row.attempts + 1;
          const waitMs = Math.min(2 ** attempts * 60_000, 6 * 3600_000); // 2, 4, 8 … minutes, at most 6 hours
          const error = result.error || `HTTP ${result.status}${result.body && result.body.error ? ` ${String(result.body.error).slice(0, 80)}` : ''}`;
          db.prepare('UPDATE repdesk_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(attempts, new Date(Date.now() + waitMs).toISOString(), error, row.id);
          log.error('repdesk_retry', { outbox: row.id, attempts, error });
        }
      }
    } finally {
      busy = false;
    }
  }

  ctx.timers.push(setInterval(() => { flush().catch((err) => log.error('repdesk_flush', { error: err.message })); }, 60_000).unref());
  return { enabled: true, flush: () => flush().catch((err) => log.error('repdesk_flush', { error: err.message })) };
}

module.exports = { createRepdeskForwarder, outboxPayload, queue, FORM_URL_RE };
