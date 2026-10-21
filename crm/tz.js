/* Georgia-time (America/New_York) date helpers for the CRM UI.
   Everything the CRM shows or accepts is in the business's time zone, not the browser's.
   Loaded as a plain script (window.CrmTz) and also require()-able by the tests. */
(function (root) {
  'use strict';
  let TZ = 'America/New_York';
  const cache = new Map();
  function fmt(opts) {
    const key = TZ + JSON.stringify(opts);
    if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }));
    return cache.get(key);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /** Wall-clock parts of a Date in the CRM zone. */
  function parts(date) {
    const o = {};
    for (const p of fmt({ hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date)) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD[o.weekday] };
  }
  function offsetMs(date) {
    const p = parts(date);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
  }
  /** Wall-clock time in the CRM zone -> Date. */
  function toDate(y, m, d, h, mi) {
    const guess = Date.UTC(y, m - 1, d, h || 0, mi || 0);
    let t = guess - offsetMs(new Date(guess));
    t = guess - offsetMs(new Date(t));
    return new Date(t);
  }
  /** ISO -> "YYYY-MM-DDTHH:MM" for <input type=datetime-local>, in Georgia time. */
  function toInput(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return '';
    const p = parts(t);
    return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
  }
  /** "YYYY-MM-DDTHH:MM" (Georgia time) -> ISO string. */
  function fromInput(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
    if (!m) return v ? v : '';
    return toDate(+m[1], +m[2], +m[3], +m[4], +m[5]).toISOString();
  }
  function startOfDay(date) { const p = parts(date || new Date()); return toDate(p.y, p.m, p.d, 0, 0); }
  function addDays(date, n) {
    const p = parts(date);
    const b = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return toDate(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate(), p.h, p.mi);
  }
  function endOfDay(date) { return new Date(addDays(startOfDay(date), 1).getTime() - 1); }
  /** Date at `hour`:00 Georgia time, `days` days from today. */
  function dayAt(days, hour) {
    const p = parts(addDays(new Date(), days));
    return toDate(p.y, p.m, p.d, hour, 0);
  }
  function dayKey(iso) { const p = parts(new Date(iso)); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }

  const api = {
    setZone(z) { if (z) { TZ = z; cache.clear(); } },
    zone: () => TZ,
    parts, toDate, toInput, fromInput, startOfDay, endOfDay, addDays, dayAt, dayKey,
    format: (date, opts) => fmt(opts).format(date),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CrmTz = api;
}(typeof window !== 'undefined' ? window : this));
