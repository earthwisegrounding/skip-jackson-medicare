'use strict';
// Domain operations shared by the public intake and the CRM API.

const { insert, update } = require('./db');
const { STAGES, CONSENT_CHANNELS } = require('./constants');

const STAGE_LABEL = Object.fromEntries(STAGES);
const STAGE_ORDER = Object.fromEntries(STAGES.map(([k], i) => [k, i]));
const nowIso = () => new Date().toISOString();

function contactName(c) {
  if (!c) return '';
  return [c.first_name, c.last_name].filter(Boolean).join(' ');
}

/** Append to the audit log. `summary` must never contain passwords or PII values. */
function audit(db, { user, action, entity = null, entityId = null, summary = null, ip = null }) {
  db.prepare('INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, summary, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(user ? user.id : null, user ? user.name : null, action, entity, entityId ?? null,
      summary ? String(summary).slice(0, 500) : null, ip ? String(ip).slice(0, 64) : null, nowIso());
}

function addActivity(db, { contactId, type, direction = null, body = null, meta = null, occurredAt = null, userId = null, recorded = null, durationMin = null }) {
  const now = nowIso();
  const id = insert(db, 'activities', {
    contact_id: contactId, type, direction, body, meta: meta ? JSON.stringify(meta) : null,
    occurred_at: occurredAt || now, user_id: userId, recorded, duration_min: durationMin, created_at: now, updated_at: now,
  });
  db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(now, contactId);
  return id;
}

/** Change a contact's stage and record a stage_change activity. Returns true if changed. */
function changeStage(db, contact, newStage, { user = null, note = null } = {}) {
  if (!STAGE_LABEL[newStage] || contact.stage === newStage) return false;
  const now = nowIso();
  db.prepare('UPDATE contacts SET stage = ?, updated_at = ? WHERE id = ?').run(newStage, now, contact.id);
  addActivity(db, {
    contactId: contact.id, type: 'stage_change', userId: user ? user.id : null,
    body: `Stage changed from ${STAGE_LABEL[contact.stage] || contact.stage} to ${STAGE_LABEL[newStage]}${note ? ` (${note})` : ''}`,
    meta: { from: contact.stage, to: newStage, automatic: Boolean(note) },
  });
  contact.stage = newStage;
  return true;
}

/** Move a contact forward (never backward) to `target` stage, e.g. after logging a call. */
function advanceStage(db, contact, target, user, note) {
  const closed = ['enrolled', 'not_now', 'lost'];
  if (closed.includes(contact.stage) && target !== 'enrolled') return false;
  if ((STAGE_ORDER[contact.stage] ?? 0) >= STAGE_ORDER[target]) return false;
  return changeStage(db, contact, target, { user, note });
}

const crypto = require('node:crypto');
const PHONE_CHANNELS = ['call', 'text', 'automated'];

/**
 * Find an existing (not deleted) contact by phone or email.
 * Returns {contact, matchType: 'phone'|'email'} or null. A phone match wins over an email match.
 */
function findDuplicate(db, phone, email) {
  if (phone) {
    const c = db.prepare('SELECT * FROM contacts WHERE phone = ? AND deleted_at IS NULL ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT 1').get(phone);
    if (c) return { contact: c, matchType: 'phone' };
  }
  if (email) {
    const c = db.prepare('SELECT * FROM contacts WHERE email = ? AND deleted_at IS NULL ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT 1').get(email);
    if (c) return { contact: c, matchType: 'email' };
  }
  return null;
}

/** All live contacts sharing this phone or email, phone matches first. */
function findCandidates(db, phone, email) {
  const out = [];
  const seen = new Set();
  if (phone) for (const c of db.prepare('SELECT * FROM contacts WHERE phone = ? AND deleted_at IS NULL ORDER BY archived_at IS NOT NULL, updated_at DESC').all(phone)) { seen.add(c.id); out.push({ contact: c, matchType: 'phone' }); }
  if (email) for (const c of db.prepare('SELECT * FROM contacts WHERE email = ? AND deleted_at IS NULL ORDER BY archived_at IS NOT NULL, updated_at DESC').all(email)) if (!seen.has(c.id)) out.push({ contact: c, matchType: 'email' });
  return out;
}

// ---------- Call-back tasks ----------
function openCallback(db, contactId) {
  return db.prepare("SELECT * FROM tasks WHERE contact_id = ? AND kind = 'callback' AND done_at IS NULL ORDER BY id LIMIT 1").get(contactId) || null;
}
/** Close open call-back tasks for a contact; returns how many were closed. */
function completeCallbacks(db, contactId, note) {
  const rows = db.prepare("SELECT id, notes FROM tasks WHERE contact_id = ? AND kind = 'callback' AND done_at IS NULL").all(contactId);
  const now = nowIso();
  for (const t of rows) {
    db.prepare('UPDATE tasks SET done_at = ?, notes = ?, updated_at = ? WHERE id = ?').run(now, [t.notes, note].filter(Boolean).join('\n').slice(0, 2000), now, t.id);
  }
  return rows.length;
}
/** The user if active, otherwise the default assignee (first active admin unless configured). */
function activeAssignee(db, userId) {
  if (userId && db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) return userId;
  return defaultAssignee(db);
}

/** Case- and accent-insensitive comparison of first + last name. */
function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}
function sameName(a, b) {
  return normName(a.first_name) === normName(b.first_name) && normName(a.last_name) === normName(b.last_name) && normName(a.last_name) !== '';
}

// ---------- Suppression list (survives permanent delete) ----------
const idHash = (kind, value) => crypto.createHash('sha256').update(`${kind}:${value}`).digest('hex');

function addSuppression(db, { phone, email, channel, source, at = nowIso() }) {
  const stmt = db.prepare('INSERT INTO suppressions (identifier_hash, kind, channel, revoked_at, source) VALUES (?, ?, ?, ?, ?)');
  if (channel === 'email') { if (email) stmt.run(idHash('email', email), 'email', channel, at, source || null); }
  else if (phone) stmt.run(idHash('phone', phone), 'phone', channel, at, source || null);
}

/** Most recent suppression time for this identifier + channel, or null. */
function suppressedAt(db, { phone, email }, channel) {
  const value = channel === 'email' ? email : phone;
  if (!value) return null;
  const row = db.prepare('SELECT MAX(revoked_at) AS at FROM suppressions WHERE identifier_hash = ? AND channel = ?')
    .get(idHash(channel === 'email' ? 'email' : 'phone', value), channel);
  return row ? row.at : null;
}

/**
 * Current consent per channel, derived from the append-only log.
 * - Only effective rows count (web consent awaiting review does not).
 * - Phone channels only count grants that cover the contact's CURRENT phone number.
 * - A revocation always beats an older grant, whatever number it was recorded with.
 * - Suppression-list opt-outs (by phone/email hash) beat older grants.
 * - Do-not-contact overrides everything.
 */
function consentState(db, contactOrId) {
  const contact = typeof contactOrId === 'object' ? contactOrId : db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactOrId);
  const out = {};
  for (const [ch] of CONSENT_CHANNELS) out[ch] = { granted: false, captured_at: null, source: null, pending: 0 };
  if (!contact) return out;
  const rows = db.prepare('SELECT * FROM consents WHERE contact_id = ? ORDER BY captured_at, id').all(contact.id);
  for (const [ch] of CONSENT_CHANNELS) {
    let latestGrant = null;
    let latestRevoke = null;
    for (const r of rows) {
      if (r.channel !== ch) continue;
      if (!r.granted) { latestRevoke = r; continue; }
      if (!r.effective) { out[ch].pending += isPendingConsent(rows, r) ? 1 : 0; continue; }
      if (ch !== 'email' && (!contact.phone || r.phone !== contact.phone)) continue;
      latestGrant = r;
    }
    const sup = suppressedAt(db, contact, ch);
    const revokeAt = [latestRevoke && latestRevoke.captured_at, sup].filter(Boolean).sort().pop() || null;
    if (latestGrant && (!revokeAt || latestGrant.captured_at > revokeAt) && !contact.do_not_contact) {
      out[ch] = { ...out[ch], granted: true, captured_at: latestGrant.captured_at, source: latestGrant.source };
    } else if (revokeAt) {
      out[ch] = { ...out[ch], granted: false, captured_at: revokeAt, source: latestRevoke && latestRevoke.captured_at === revokeAt ? latestRevoke.source : 'suppression' };
    }
  }
  return out;
}

function isPendingConsent(rows, r) {
  return !r.effective && r.granted && !rows.some((x) => x.accepted_from_id === r.id);
}

/** Append a consent row. Revocations also go on the suppression list. */
function recordConsent(db, row) {
  const full = { captured_at: nowIso(), effective: 1, ...row, granted: row.granted ? 1 : 0 };
  const id = insert(db, 'consents', full);
  if (!full.granted) addSuppression(db, { phone: full.phone, email: full.email, channel: full.channel, source: full.source, at: full.captured_at });
  return id;
}

/** Turn do-not-contact on/off. Turning it on revokes every channel (new rows, never edits). */
function setDnc(db, contact, on, { reason = null, user = null, ip = null }) {
  const now = nowIso();
  if (on) {
    update(db, 'contacts', contact.id, { do_not_contact: 1, dnc_reason: reason, dnc_at: now, updated_at: now });
    for (const [ch] of CONSENT_CHANNELS) {
      recordConsent(db, { contact_id: contact.id, channel: ch, granted: 0, phone: contact.phone, email: contact.email, source: 'manual', notes: `Do not contact${reason ? `: ${reason}` : ''}`.slice(0, 500), recorded_by_user_id: user ? user.id : null, ip });
    }
    const closed = completeCallbacks(db, contact.id, 'Closed automatically: contact marked do-not-contact.');
    addActivity(db, { contactId: contact.id, type: 'system', userId: user ? user.id : null, body: `Marked DO NOT CONTACT${reason ? ` — ${reason}` : ''}. All consents revoked.${closed ? ` ${closed} open call-back task${closed === 1 ? '' : 's'} closed.` : ''}` });
  } else {
    update(db, 'contacts', contact.id, { do_not_contact: 0, dnc_reason: null, dnc_at: null, updated_at: now });
    db.prepare('UPDATE contact_requests SET dnc_reviewed_at = ? WHERE contact_id = ? AND while_dnc = 1 AND dnc_reviewed_at IS NULL').run(now, contact.id);
    addActivity(db, { contactId: contact.id, type: 'system', userId: user ? user.id : null, body: `Do-not-contact removed${reason ? ` — ${reason}` : ''}. Every channel stays revoked until new consent is recorded.` });
  }
}

function defaultAssignee(db) {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'default_assignee_user_id'").get();
  if (s && s.value) {
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(Number(s.value));
    if (u) return u.id;
  }
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
  return admin ? admin.id : null;
}

module.exports = {
  nowIso, contactName, audit, addActivity, changeStage, advanceStage, findDuplicate, consentState, recordConsent,
  setDnc, defaultAssignee, activeAssignee, findCandidates, openCallback, completeCallbacks, STAGE_LABEL, STAGE_ORDER, sameName, normName, addSuppression, suppressedAt, idHash, isPendingConsent, PHONE_CHANNELS,
};
