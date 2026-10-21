'use strict';
const { HttpError } = require('../http');
const { validate } = require('../validate');
const S = require('../services');

const fail = (status, code, extra) => { throw new HttpError(status, code, extra); };

/** Validate or throw a 400 with field errors. */
function check(schema, input, opts) {
  const v = validate(schema, input, opts);
  if (!v.ok) fail(400, 'validation', { errors: v.errors });
  return v.values;
}

function mustGet(db, table, id, label = table) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) fail(404, 'not_found');
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(n);
  if (!row) fail(404, 'not_found', { message: `That ${label} no longer exists.` });
  return row;
}

function auditR(db, r, action, entity, entityId, summary) {
  S.audit(db, { user: r.user, action, entity, entityId, summary, ip: r.ip });
}

/** Field names whose values differ (for audit summaries; never the values). */
function changedFields(before, after) {
  return Object.keys(after).filter((k) => (before[k] ?? null) !== (after[k] ?? null));
}

function paging(query, { max = 100, def = 25 } = {}) {
  const page = Math.max(1, Math.min(100000, parseInt(query.get('page'), 10) || 1));
  const perPage = Math.max(1, Math.min(max, parseInt(query.get('per_page'), 10) || def));
  return { page, perPage, offset: (page - 1) * perPage };
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const created = (body) => ({ __status: 201, body });

function userExists(db, id) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
}

module.exports = { fail, check, mustGet, auditR, changedFields, paging, likeEscape, created, userExists };
