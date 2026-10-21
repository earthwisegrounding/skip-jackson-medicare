'use strict';
// Date helpers anchored to Georgia time (America/New_York). No dependencies.

const TZ = process.env.CRM_TIMEZONE || 'America/New_York';

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `date` in the CRM time zone. */
function zonedParts(date, tz = TZ) {
  const out = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    y: Number(out.year), m: Number(out.month), d: Number(out.day),
    h: Number(out.hour) % 24, mi: Number(out.minute), s: Number(out.second), wd: WEEKDAYS[out.weekday],
  };
}

function offsetMs(date, tz = TZ) {
  const p = zonedParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in the CRM zone to a Date (UTC instant). */
function zonedToDate(y, m, d, h = 0, mi = 0, tz = TZ) {
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  let t = guess - offsetMs(new Date(guess), tz);
  const off2 = offsetMs(new Date(t), tz);
  t = guess - off2;
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, '0');
function localDate(date = new Date()) {
  const p = zonedParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
function localMonth(date = new Date()) { return localDate(date).slice(0, 7); }

function startOfLocalDay(date = new Date()) {
  const p = zonedParts(date);
  return zonedToDate(p.y, p.m, p.d, 0, 0);
}
function addDaysLocal(date, n) {
  const p = zonedParts(date);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return zonedToDate(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), p.h, p.mi);
}

/** Same wall-clock time, `n` business days (Mon-Fri) later. */
function addBusinessDays(date, n = 1) {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDaysLocal(d, 1);
    const wd = zonedParts(d).wd;
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
}

/** Annual Enrollment Period (Oct 15 - Dec 7) status for the current local date. */
function aepStatus(date = new Date()) {
  const p = zonedParts(date);
  const md = p.m * 100 + p.d;
  const inAep = md >= 1015 && md <= 1207;
  const today = Date.UTC(p.y, p.m - 1, p.d);
  const end = Date.UTC(p.y, 11, 7);
  const start = Date.UTC(p.y, 9, 15);
  return {
    active: inAep,
    year: p.y,
    days_left: inAep ? Math.round((end - today) / 864e5) : null,
    days_until: !inAep && md < 1015 ? Math.round((start - today) / 864e5) : null,
    review_since: zonedToDate(p.y, 9, 1).toISOString(), // Sept 1 of this year
  };
}

/**
 * Turning-65 (Medicare eligibility) month, YYYY-MM, from a date of birth (YYYY-MM-DD).
 * Medicare treats someone born on the 1st as turning 65 in the PREVIOUS month.
 */
function turning65FromDob(dob) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  let y = Number(dob.slice(0, 4)) + 65;
  let m = Number(dob.slice(5, 7));
  if (Number(dob.slice(8, 10)) === 1) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return `${y}-${pad(m)}`;
}

/** 10:00 AM Georgia time on the next business day after `date`. */
function nextBusinessDayAt(date = new Date(), hour = 10) {
  const d = addBusinessDays(date, 1);
  const p = zonedParts(d);
  return zonedToDate(p.y, p.m, p.d, hour, 0);
}

module.exports = {
  TZ, zonedParts, zonedToDate, localDate, localMonth, startOfLocalDay, addDaysLocal, addBusinessDays,
  addMonths, aepStatus, turning65FromDob, nextBusinessDayAt,
};

const longFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** Human-readable local time for timeline text, e.g. "Thu, Oct 22, 2026, 2:00 PM". */
function formatLocal(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? longFmt.format(new Date(t)) : '';
}
module.exports.formatLocal = formatLocal;

/** "2026-10-21 14:05" in Georgia time (for CSV exports). */
function localDateTimeText(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const p = zonedParts(new Date(t));
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}
module.exports.localDateTimeText = localDateTimeText;
