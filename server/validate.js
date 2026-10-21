'use strict';
// Tiny declarative validator. Each rule returns a cleaned value or throws a message.

class Invalid extends Error {}

const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function normPhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  return null;
}

/** Accept 30303, 30303-1234 or 303031234; store the 5-digit ZIP. */
function normZip(v) {
  const s = String(v).trim();
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(s);
  if (!m) throw new Invalid('Please enter a 5-digit ZIP code.');
  return m[1];
}

function formatPhone(d) {
  if (!d || d.length !== 10) return d || '';
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1900 && y <= 2200;
}

// Control characters never belong in stored text (they break CSV, .ics and terminals).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const FORMAT = /\p{Cf}/gu; // zero-width and bidi controls; stripped from public-facing text
const str = (max, label = 'This field', strict = false) => (v) => {
  let s = String(v).replace(/[\r\n\t]+/g, ' ').replace(CONTROL, '');
  if (strict) s = s.replace(FORMAT, '');
  s = s.trim();
  if (s.length > max) throw new Invalid(`${label} must be ${max} characters or fewer.`);
  return s;
};

const T = {
  string: (max = 200) => ({ parse: str(max) }),
  text: (max = 5000) => ({ parse: (v) => { const s = String(v).replace(/\r\n?/g, '\n').replace(CONTROL, '').trim(); if (s.length > max) throw new Invalid(`Please keep this under ${max} characters.`); return s; } }),
  /** Public-facing single line: also strips zero-width/bidi format characters. */
  cleanString: (max = 200) => ({ parse: str(max, 'This field', true) }),
  /** Public-facing multi-line text: also strips zero-width/bidi format characters. */
  cleanText: (max = 5000) => ({ parse: (v) => { const s = String(v).replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(FORMAT, '').trim(); if (s.length > max) throw new Invalid(`Please keep this under ${max} characters.`); return s; } }),
  enum: (values, msg = 'Please choose a valid option.') => ({ parse: (v) => { const s = String(v).trim(); if (!values.includes(s)) throw new Invalid(msg); return s; } }),
  email: () => ({ parse: (v) => { const s = String(v).trim().toLowerCase(); if (s.length > 120 || !EMAIL_RE.test(s)) throw new Invalid('Please enter a valid email address.'); return s; } }),
  phone: () => ({ parse: (v) => { const p = normPhone(v); if (!p) throw new Invalid('Please enter a 10-digit phone number.'); return p; } }),
  zip: () => ({ parse: (v) => normZip(v) }),
  state: () => ({ parse: (v) => { const s = String(v).trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(s)) throw new Invalid('Use the 2-letter state code.'); return s; } }),
  date: () => ({ parse: (v) => { const s = String(v).trim(); if (!isRealDate(s)) throw new Invalid('Please enter a valid date (YYYY-MM-DD).'); return s; } }),
  month: () => ({ parse: (v) => { const s = String(v).trim(); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw new Invalid('Please use the format YYYY-MM.'); return s; } }),
  datetime: () => ({ parse: (v) => { const s = String(v).trim(); const t = Date.parse(s); if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(t)) throw new Invalid('Please enter a valid date and time.'); return new Date(t).toISOString(); } }),
  bool: () => ({ parse: (v) => { if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on') return 1; if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no' || v === '') return 0; throw new Invalid('Must be yes or no.'); } }),
  int: (min = 0, max = 1e9) => ({ parse: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Invalid(`Please enter a whole number from ${min} to ${max}.`); return n; } }),
  money: () => ({ parse: (v) => { const n = Number(String(v).replace(/[$,\s]/g, '')); if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Invalid('Please enter an amount like 25.50.'); return Math.round(n * 100) / 100; } }),
  id: () => ({ parse: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Invalid('Invalid selection.'); return n; } }),
  enumList: (values) => ({ parse: (v) => { const arr = Array.isArray(v) ? v : String(v).split(','); const out = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))]; for (const x of out) if (!values.includes(x)) throw new Invalid('Please choose valid options.'); return out; } }),
  tags: () => ({ parse: (v) => { const arr = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean); const out = [...new Set(arr)].slice(0, 20); if (out.some((t) => t.length > 40)) throw new Invalid('Tags must be 40 characters or fewer.'); return out.join(', '); } }),
};

/**
 * Validate `input` against `schema` ({field: {type, required, label}}).
 * partial=true: only fields present in input are validated (PATCH).
 * Empty strings become null for optional fields.
 */
function validate(schema, input, { partial = false } = {}) {
  const values = {};
  const errors = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const [field, rule] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(src, field);
    if (partial && !present) continue;
    let raw = src[field];
    if (typeof raw === 'string') raw = raw.trim();
    const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0 && !rule.allowEmptyList);
    if (empty) {
      if (rule.required) errors[field] = rule.requiredMessage || `${rule.label || 'This field'} is required.`;
      else if (rule.default !== undefined && !partial) values[field] = rule.default;
      else if (present || !partial) values[field] = null;
      continue;
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) { errors[field] = 'Invalid value.'; continue; }
    try {
      values[field] = rule.type.parse(raw);
    } catch (err) {
      if (err instanceof Invalid) errors[field] = err.message.replace(/^This field/, rule.label || 'This field');
      else throw err;
    }
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

module.exports = { T, validate, Invalid, normPhone, normZip, formatPhone, isRealDate, EMAIL_RE };
