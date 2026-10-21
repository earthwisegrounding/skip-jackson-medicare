'use strict';
// Public, server-rendered pages: home (upcoming events injected), /events/, event detail, the
// no-sign-up join page for online events, .ics download, RSVP posts + confirmation, and the
// /login and /staff shortcuts.

const fs = require('node:fs');
const path = require('node:path');
const { readBody, parseForm, mediaType, sendJson, sendText, redirect, clientIp, originAllowed, HttpError } = require('./http');
const { RateLimiter, ipKey } = require('./ratelimit');
const { validate } = require('./validate');
const { tx } = require('./db');
const E = require('./events');
const R = require('./events-render');
const { storeLead, MIN_FILL_MS } = require('./leads');

const BODY_LIMIT = 20 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/;
const NOINDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };

/** Rewrite the template's relative links ("../x") to root-relative ("/x") so any URL depth works. */
const toRoot = (html) => html.replace(/(=")\.\.\//g, (m, a) => `${a}/`);

function between(html, start, end, replacement) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < 0 || b < a) return html;
  return html.slice(0, a) + replacement + html.slice(b + end.length);
}
/** String.replace with a literal replacement (never interprets $&, $1, $` ...). */
const put = (html, pattern, text) => html.replace(pattern, () => text);

function createEventsPublic(ctx) {
  const { db, cfg, log } = ctx;
  const limiter = new RateLimiter([
    { windowMs: 10 * 60 * 1000, max: cfg.leadLimitShort }, { windowMs: 24 * 60 * 60 * 1000, max: cfg.leadLimitDaily },
  ], { keyFn: ipKey, maxKeys: cfg.rateLimitMaxKeys });
  const failLimiter = new RateLimiter([{ windowMs: 10 * 60 * 1000, max: cfg.leadFailLimit }], { keyFn: ipKey, maxKeys: cfg.rateLimitMaxKeys });
  ctx.timers.push(setInterval(() => { limiter.prune(); failLimiter.prune(); }, 10 * 60 * 1000).unref());

  const tplPath = path.join(cfg.publicDir, 'events', 'index.html');
  const homePath = path.join(cfg.publicDir, 'index.html');
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  // Absolute URLs only from configuration (PUBLIC_URL), never from the request's Host header.
  const baseUrl = () => cfg.publicUrl || '';

  function page(req, res, status, { title, description, main, head = '', headers = {}, canonicalPath = null }) {
    const tpl = read(tplPath);
    if (!tpl) { sendText(res, 500, 'Events template missing'); return; }
    let html = toRoot(tpl);
    if (title) {
      html = put(html, /<title>[\s\S]*?<\/title>/, `<title>${R.esc(title)}</title>`);
      html = html.replace(/(<meta property="og:title" content=")[^"]*(">)/, (m, a, b) => `${a}${R.esc(title)}${b}`);
    }
    if (description) {
      html = html.replace(/(<meta name="description" content=")[^"]*(">)/, (m, a, b) => `${a}${R.esc(description)}${b}`)
        .replace(/(<meta property="og:description" content=")[^"]*(">)/, (m, a, b) => `${a}${R.esc(description)}${b}`);
    }
    if (canonicalPath) html = html.replace(/(<link rel="canonical" href="https:\/\/[^/"]+)\/events\/(">)/, (m, a, b) => `${a}${R.esc(canonicalPath)}${b}`);
    if (main !== undefined) html = between(html, '<!-- EVENTS:MAIN:START -->', '<!-- EVENTS:MAIN:END -->', main);
    html = put(html, '<!-- EVENTS:HEAD -->', head);
    sendText(res, status, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store', ...headers });
  }
  const tpmoBand = () => { const m = /<aside class="tpmo"[\s\S]*?<\/aside>/.exec(read(tplPath) || ''); return m ? toRoot(m[0]) : ''; };

  // ---------- Home ----------
  function home(req, res) {
    const html = read(homePath);
    if (!html) return false;
    const upcoming = E.publicEvents(db, { limit: 3, includeCancelled: false });
    const out = put(html, /<!-- EVENTS:HOME[^>]*-->/, R.homeSection(upcoming));
    sendText(res, 200, out, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
    return true;
  }

  // ---------- Listing ----------
  function listing(req, res, url) {
    const all = E.publicEvents(db);
    const cities = [...new Set(all.filter((e) => e.format === 'in_person' && e.city).map((e) => e.city.trim()))].sort((a, b) => a.localeCompare(b));
    const city = (url.searchParams.get('city') || '').trim().slice(0, 80);
    let format = url.searchParams.get('format') || '';
    if (!['', 'in_person', 'online'].includes(format)) format = '';
    const events = all.filter((e) => (!city || (e.city || '').trim().toLowerCase() === city.toLowerCase()) && (!format || e.format === format));
    const tpl = read(tplPath);
    if (!tpl) { sendText(res, 500, 'Events template missing'); return; }
    let html = toRoot(tpl);
    html = between(html, '<!-- EVENTS:LIST:START -->', '<!-- EVENTS:LIST:END -->', R.renderList(events, { city, format, cities, filtered: Boolean(city || format) }));
    html = put(html, '<!-- EVENTS:HEAD -->', '');
    sendText(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
  }

  // ---------- Detail ----------
  function detailHtml(req, e, { form = {}, preview = false } = {}) {
    const full = e.capacity ? E.seatsTaken(db, e.id) >= e.capacity : false;
    return {
      title: `${e.title} | Events | Skip Jackson, Licensed Insurance Agent`,
      description: (e.summary || `${R.fmtDay(e.starts_at)} event with Skip Jackson, licensed insurance agent.`).slice(0, 200),
      main: R.renderDetail(e, { tpmo: tpmoBand(), form, full, token: ctx.formTokens.issue().token, preview, following: E.followingSalesEvent(db, e) }),
      head: R.jsonLd(e, baseUrl()),
      canonicalPath: `/events/${encodeURIComponent(e.slug)}/`,
    };
  }
  function detail(req, res, slug, notFound) {
    const e = E.publicEventBySlug(db, slug);
    if (!e) { notFound(); return; }
    page(req, res, 200, detailHtml(req, e));
  }
  /** Staff-only preview (drafts included). Called from the CRM API. */
  function preview(req, res, e) {
    page(req, res, 200, { ...detailHtml(req, { ...e, slug: e.slug || E.slugify(e.title) }, { preview: true }), head: '', headers: NOINDEX });
  }

  function calendar(req, res, slug, notFound) {
    const e = E.publicEventBySlug(db, slug);
    if (!e) { notFound(); return; }
    const body = R.ics(e, baseUrl());
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${e.slug}.ics"`,
      'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---------- Online join (no contact details required: 42 CFR 422.2264(c)(2)) ----------
  function join(req, res, slug, notFound) {
    if (!originAllowed(req, cfg)) { sendText(res, 403, 'Forbidden'); return; }
    const e = E.publicEventBySlug(db, slug);
    if (!e || e.format !== 'online' || e.status !== 'published') { notFound(); return; }
    req.resume();
    page(req, res, 200, { title: `Join | ${e.title}`, main: R.renderJoin(e), headers: NOINDEX });
  }

  function confirmed(req, res, slug, url, notFound) {
    const e = E.publicEventBySlug(db, slug);
    const r = e ? E.rsvpByConfirmToken(db, e.id, url.searchParams.get('t')) : null;
    if (!r) {
      page(req, res, 404, { title: 'Confirmation link expired', headers: NOINDEX,
        main: '<section class="page-hero"><div class="container"><h1 id="page-title">This confirmation link has expired</h1><p class="lead">Your sign-up is still saved. Call (404) 354-7597 if you need the details again.</p></div></section>' });
      return;
    }
    page(req, res, 200, { title: `You're signed up | ${e.title}`, main: R.renderSuccess(e, r), headers: NOINDEX });
  }

  // ---------- RSVP ----------
  async function rsvp(req, res, slug, notFound) {
    const type = mediaType(req);
    const isJson = type === 'application/json';
    if (!isJson && type !== 'application/x-www-form-urlencoded') { sendJson(res, 415, { ok: false, error: 'unsupported_media_type' }); return; }
    if (!originAllowed(req, cfg)) { if (isJson) sendJson(res, 403, { ok: false, error: 'forbidden' }); else sendText(res, 403, 'Forbidden'); return; }
    const browserHeaders = Boolean(req.headers.origin || req.headers['sec-fetch-site']);
    let raw;
    try { raw = await readBody(req, BODY_LIMIT); } catch (err) {
      if (err instanceof HttpError && err.status === 413) { sendText(res, 413, 'Too much text. Please shorten it, or call (404) 354-7597.'); return; }
      throw err;
    }
    const ip = clientIp(req, cfg);
    if (limiter.blocked(ip) || failLimiter.blocked(ip)) {
      if (isJson) sendJson(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '600' });
      else sendText(res, 429, '<!doctype html><meta charset="utf-8"><title>Please wait</title><p>Too many requests from this device. Please wait a few minutes, or call Skip at <a href="tel:+14043547597">(404) 354-7597</a>.</p>', 'text/html; charset=utf-8', { 'Retry-After': '600' });
      return;
    }
    let input = {};
    if (isJson) { try { input = JSON.parse(raw || '{}'); } catch { input = {}; } } else input = parseForm(raw);
    const clean = {};
    for (const [k, v] of Object.entries(input || {})) if (typeof v === 'string' || typeof v === 'number') clean[k] = String(v);

    const e = E.publicEventBySlug(db, slug);
    if (!e) { notFound(); return; }
    const fakeOk = () => {
      limiter.hit(ip);
      if (isJson) { sendJson(res, 201, { ok: true }); return; }
      page(req, res, 200, { title: 'Thank you | Events', headers: NOINDEX, main: '<section class="page-hero"><div class="container"><h1 id="page-title">Thank you</h1><p class="lead">Your sign-up was received.</p></div></section>' });
    };
    if ((clean.website || '').trim()) { log.info('rsvp_trap', { reason: 'honeypot' }); fakeOk(); return; }
    // A present token is always time-checked; a missing or invalid one makes the RSVP "unverified".
    const token = ctx.formTokens.verify(clean.form_token);
    if (token.valid && Date.now() - token.issuedAt < MIN_FILL_MS) { log.info('rsvp_trap', { reason: 'too_fast' }); fakeOk(); return; }
    const verified = token.valid && browserHeaders;

    const respondError = (status, errors, { countFail = true } = {}) => {
      if (countFail) failLimiter.hit(ip);
      if (isJson) { sendJson(res, status, { ok: false, errors }); return; }
      const values = { ...clean };
      delete values.form_token; delete values.website;
      page(req, res, status, detailHtml(req, e, { form: { values, errors } }));
    };
    if (e.status === 'cancelled' || !e.rsvp_enabled) { respondError(409, { form: 'Sign-up is closed for this event.' }); return; }
    if (Date.parse(e.starts_at) <= Date.now()) { respondError(409, { form: 'Sign-up has closed because this event has started.' }); return; }

    const { values: v, errors } = validate(E.rsvpSchema, clean);
    if (!errors.phone && !errors.email && !v.phone && !v.email) errors.phone = 'Please enter a phone number or an email address, so we can reach you if anything changes.';
    if (Object.keys(errors).length) { respondError(400, errors); return; }

    let problem = null;
    let stored = null;
    tx(db, () => {
      // One RSVP per person per event: a repeat (same phone or email) updates the earlier one.
      const existing = db.prepare(`SELECT * FROM event_rsvps WHERE event_id = ? AND status = 'going'
        AND ((phone IS NOT NULL AND phone = ?) OR (email IS NOT NULL AND email = ?)) ORDER BY id LIMIT 1`).get(e.id, v.phone || '\u0000', v.email || '\u0000');
      const seats = 1 + (v.guests || 0);
      const fromIp = db.prepare("SELECT COALESCE(SUM(1 + guests), 0) AS n FROM event_rsvps WHERE event_id = ? AND status = 'going' AND ip = ? AND id != ?")
        .get(e.id, ip, existing ? existing.id : 0).n;
      if (fromIp + seats > E.SEAT_CAP_PER_IP) { problem = 'ip_cap'; return; }
      const countsTowardCapacity = verified || (existing && existing.verified);
      if (countsTowardCapacity && e.capacity && E.seatsTaken(db, e.id, { exceptId: existing ? existing.id : 0 }) + seats > e.capacity) { problem = 'full'; return; }
      stored = E.storeRsvp(db, e, v, {
        ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300), origin: String(req.headers.origin || '').slice(0, 200) || null,
        verified, verifyReason: token.valid ? (browserHeaders ? null : 'no browser Origin header') : token.reason, browserHeaders, storeLead,
        existingId: existing ? existing.id : null,
      });
    });
    if (problem === 'ip_cap') { respondError(429, { form: `For groups larger than ${E.SEAT_CAP_PER_IP}, please call (404) 354-7597 and Skip will save your seats.` }, { countFail: false }); return; }
    if (problem === 'full') { limiter.hit(ip); respondError(409, { form: 'This event is full. Call (404) 354-7597 to join the waitlist.' }, { countFail: false }); return; }
    limiter.hit(ip);
    if (isJson) { sendJson(res, 201, { ok: true }); return; }
    // Post/Redirect/Get: refreshing the confirmation never re-posts. The token (not the join info) is in the URL.
    redirect(res, 303, `/events/${encodeURIComponent(e.slug)}/confirmed?t=${encodeURIComponent(stored.confirmToken)}`);
  }

  /** Returns true when the request was handled. */
  async function handle(req, res, pathname, url, notFound) {
    const get = req.method === 'GET' || req.method === 'HEAD';
    if ((pathname === '/login' || pathname === '/staff') && get) { redirect(res, 302, '/crm/'); return true; }
    if ((pathname === '/' || pathname === '/index.html') && get) return home(req, res);
    if (pathname === '/events' && get) { redirect(res, 301, '/events/'); return true; }
    if ((pathname === '/events/' || pathname === '/events/index.html') && get) { listing(req, res, url); return true; }
    const m = /^\/events\/([^/]+)(\/(calendar\.ics|rsvp|join|confirmed)?)?$/.exec(pathname);
    if (!m) return false;
    const slug = m[1];
    if (!SLUG.test(slug)) return false;
    if (!m[2]) { if (get) { redirect(res, 301, `/events/${slug}/`); return true; } return false; }
    if (m[3] === 'calendar.ics' && get) { calendar(req, res, slug, notFound); return true; }
    if (m[3] === 'confirmed' && get) { confirmed(req, res, slug, url, notFound); return true; }
    if (m[3] === 'join') {
      if (req.method !== 'POST') { sendText(res, 405, 'Use the “Get the join link” button on the event page.', 'text/plain; charset=utf-8', { Allow: 'POST' }); return true; }
      join(req, res, slug, notFound);
      return true;
    }
    if (m[3] === 'rsvp') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true; }
      await rsvp(req, res, slug, notFound);
      return true;
    }
    if (!m[3] && get) { detail(req, res, slug, notFound); return true; }
    return false;
  }

  // Retention: event-only RSVPs lose their contact details 90 days after the event (startup + daily).
  try { E.anonymizeOldRsvps(db); } catch (err) { log.error('retention_failed', { err: err.message }); }
  ctx.timers.push(setInterval(() => { try { E.anonymizeOldRsvps(db); } catch (err) { log.error('retention_failed', { err: err.message }); } }, 24 * 3600e3).unref());

  return { handle, preview };
}

module.exports = { createEventsPublic, toRoot };
