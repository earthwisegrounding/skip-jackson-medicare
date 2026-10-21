'use strict';
// Server-side HTML (and .ics) for the public events pages. Every value is HTML-escaped;
// descriptions are plain text turned into paragraphs. No inline scripts or styles (CSP).

const { DISCLOSURES, EVENT_TYPES, ACCOMMODATION, gaDate } = require('./events');
const { TZ } = require('./time');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_LABEL = Object.fromEntries(EVENT_TYPES);

function paras(text) {
  return String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
const F = {
  day: fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  mon: fmt({ month: 'short' }),
  dnum: fmt({ day: 'numeric' }),
  wd: fmt({ weekday: 'short' }),
  month: fmt({ month: 'long', year: 'numeric' }),
  time: fmt({ hour: 'numeric', minute: '2-digit' }),
};
const fmtDay = (iso) => F.day.format(new Date(iso));
function fmtTimeRange(start, end) {
  const a = F.time.format(new Date(start));
  const b = end ? F.time.format(new Date(end)) : '';
  if (!b) return `${a} Eastern Time`;
  const [at, ap] = a.split(' ');
  const [bt, bp] = b.split(' ');
  return `${ap === bp ? at : a}–${bt} ${bp} Eastern Time`;
}
const where = (e) => (e.format === 'online' ? 'Online' : [e.venue_name, e.city].filter(Boolean).join(', '));
const fullAddress = (e) => [e.address, e.city, `GA ${e.zip || ''}`.trim()].filter(Boolean).join(', ');
const mapsUrl = (e) => `https://maps.google.com/?q=${encodeURIComponent([e.venue_name, fullAddress(e)].filter(Boolean).join(', '))}`;

function dateTile(e) {
  const d = new Date(e.starts_at);
  return `<div class="event-date" aria-hidden="true"><span class="event-date-mon">${esc(F.mon.format(d))}</span><span class="event-date-day">${esc(F.dnum.format(d))}</span><span class="event-date-wd">${esc(F.wd.format(d))}</span></div>`;
}

function eventCard(e, { base = '/events/', headingLevel = 3 } = {}) {
  const cancelled = e.status === 'cancelled';
  const url = `${base}${encodeURIComponent(e.slug)}/`;
  const h = `h${headingLevel}`;
  return `<li class="event-card${cancelled ? ' is-cancelled' : ''}">
  ${dateTile(e)}
  <div class="event-body">
    <p class="event-meta-top"><span class="event-type event-type-${esc(e.event_type)}">${esc(TYPE_LABEL[e.event_type])}</span>${e.format === 'online' ? '<span class="event-format">Online</span>' : ''}${cancelled ? '<span class="event-cancelled">Cancelled</span>' : ''}</p>
    <${h} class="event-title"><a href="${esc(url)}">${esc(e.title)}</a></${h}>
    <p class="event-when"><span class="visually-hidden">When: </span>${esc(fmtDay(e.starts_at))}<br>${esc(fmtTimeRange(e.starts_at, e.ends_at))}</p>
    <p class="event-where"><span class="visually-hidden">Where: </span>${esc(where(e))}</p>
    ${cancelled ? `<p class="event-cancel-note"><strong>This event is cancelled.</strong>${e.cancel_reason ? ` ${esc(e.cancel_reason)}` : ''}</p>` : (e.summary ? `<p class="event-summary">${esc(e.summary)}</p>` : '')}
    ${cancelled ? '' : `<p class="event-actions"><a class="btn btn-plum btn-sm" href="${esc(url)}">${e.rsvp_enabled ? 'Details and RSVP' : 'Details'}<span class="visually-hidden">: ${esc(e.title)}</span></a></p>`}
  </div>
</li>`;
}

const EMPTY = '<div class="events-empty"><p>No events are scheduled right now. Call <a href="tel:+14043547597">(404) 354-7597</a> to ask about upcoming events or to invite Skip to speak to your group.</p></div>';

function renderList(events, { city = '', format = '', cities = [], filtered = false } = {}) {
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  const filter = `<form class="events-filter" method="get" action="/events/" role="search" aria-label="Filter events">
  <div class="field"><label for="ev-city">City</label><select id="ev-city" name="city">${opt('', 'All cities', city)}${cities.map((c) => opt(c, c, city)).join('')}</select></div>
  <div class="field"><label for="ev-format">Format</label><select id="ev-format" name="format">${opt('', 'In person and online', format)}${opt('in_person', 'In person', format)}${opt('online', 'Online', format)}</select></div>
  <div class="events-filter-actions"><button class="btn btn-plum btn-sm" type="submit">Show events</button>${filtered ? '<a class="text-link" href="/events/">Clear filters</a>' : ''}</div>
</form>`;
  if (!events.length) {
    return `${cities.length ? filter : ''}${filtered ? '<div class="events-empty"><p>No events match those filters. <a href="/events/">See all events</a>, or call <a href="tel:+14043547597">(404) 354-7597</a>.</p></div>' : EMPTY}`;
  }
  const groups = new Map();
  for (const e of events) {
    const k = F.month.format(new Date(e.starts_at));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const body = [...groups.entries()].map(([month, list]) => `<section class="events-month" aria-label="${esc(month)}">
  <h2 class="events-month-title">${esc(month)}</h2>
  <ul class="event-list">
${list.map((e) => eventCard(e)).join('\n')}
  </ul>
</section>`).join('\n');
  const n = events.length;
  return `${filter}\n<p class="events-accommodation">${esc(ACCOMMODATION)}</p>\n<p class="events-count" role="status">${n} upcoming event${n === 1 ? '' : 's'}${filtered ? ` ${n === 1 ? 'matches' : 'match'} your filters` : ''}.</p>\n${body}`;
}

function disclosureBlock(e) {
  return `<div class="callout callout-gold event-disclosure"><p><strong>${e.event_type === 'marketing' ? 'About this event' : 'Educational event'}:</strong> ${esc(DISCLOSURES[e.event_type])}</p></div>`;
}

function rsvpForm(e, { values = {}, errors = {}, token = '', full = false } = {}) {
  if (e.status === 'cancelled') return `<div class="aside-card"><h2>This event is cancelled</h2><p>${esc(e.cancel_reason || 'We’re sorry for the inconvenience.')}</p><p>Questions? Call <a href="tel:+14043547597">(404) 354-7597</a>.</p></div>`;
  if (!e.rsvp_enabled) return `<div class="aside-card"><h2>No RSVP needed</h2><p>Just come. Questions? Call <a href="tel:+14043547597">(404) 354-7597</a>.</p></div>`;
  if (Date.parse(e.starts_at) <= Date.now()) return `<div class="aside-card"><h2>Sign-up has closed</h2><p>This event has started. Questions? Call <a href="tel:+14043547597">(404) 354-7597</a>.</p></div>`;
  if (full) return `<div class="aside-card"><h2>This event is full</h2><p>This event is full. Call <a href="tel:+14043547597">(404) 354-7597</a> to join the waitlist.</p></div>`;
  const v = (k) => esc(values[k] ?? '');
  const err = (k) => `<p class="field-error" id="rsvp-err-${k}">${esc(errors[k] || '')}</p>`;
  const inv = (k) => (errors[k] ? ' aria-invalid="true"' : '');
  const desc = (k, extra) => ` aria-describedby="${[extra, errors[k] ? `rsvp-err-${k}` : ''].filter(Boolean).join(' ')}"`;
  const guestOpts = [0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}"${String(values.guests ?? '0') === String(n) ? ' selected' : ''}>${n === 0 ? 'Just me' : `Me plus ${n}`}</option>`).join('');
  const errKeys = Object.keys(errors).filter((k) => k !== 'form');
  return `<form class="form-card rsvp-form" id="rsvp" method="post" action="/events/${esc(encodeURIComponent(e.slug))}/rsvp" novalidate>
  <h2>${e.format === 'online' ? 'Sign up' : 'Reserve a seat'}</h2>
  ${e.format === 'in_person' ? '<p class="rsvp-optional">You don’t have to RSVP to attend. It just helps us plan seating.</p>' : '<p class="rsvp-optional">Signing up is optional. You can get the join link above without giving any contact details.</p>'}
  ${errors.form ? `<div class="form-status err" role="alert"><p>${esc(errors.form)}</p></div>` : ''}
  ${errKeys.length ? `<div class="form-status err" role="alert"><p>Please fix ${errKeys.length === 1 ? '1 field' : `${errKeys.length} fields`} below.</p></div>` : ''}
  <div class="form-grid">
    <div class="field"><label for="rsvp-first">First name <span class="req">(required)</span></label><input id="rsvp-first" name="first_name" autocomplete="given-name" maxlength="60" required value="${v('first_name')}"${inv('first_name')}${desc('first_name')}>${err('first_name')}</div>
    <div class="field"><label for="rsvp-last">Last name <span class="req">(required)</span></label><input id="rsvp-last" name="last_name" autocomplete="family-name" maxlength="60" required value="${v('last_name')}"${inv('last_name')}${desc('last_name')}>${err('last_name')}</div>
    <div class="field"><label for="rsvp-phone">Phone <span class="hint">Phone or email, so we can reach you if anything changes</span></label><input id="rsvp-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="20" value="${v('phone')}"${inv('phone')}${desc('phone')}>${err('phone')}</div>
    <div class="field"><label for="rsvp-email">Email <span class="hint">Phone or email</span></label><input id="rsvp-email" name="email" type="email" autocomplete="email" maxlength="120" value="${v('email')}"${inv('email')}${desc('email')}>${err('email')}</div>
    <div class="field"><label for="rsvp-guests">How many people?</label><select id="rsvp-guests" name="guests"${inv('guests')}${desc('guests')}>${guestOpts}</select>${err('guests')}</div>
    <div class="field full"><label for="rsvp-acc">Anything we should know to help you take part? <span class="hint">Optional. For example: wheelchair seating, large print, or a sign language interpreter.</span></label><textarea id="rsvp-acc" name="needs_accommodation" maxlength="300" rows="3"${inv('needs_accommodation')}${desc('needs_accommodation')}>${v('needs_accommodation')}</textarea>${err('needs_accommodation')}</div>
    <div class="consent full">
      <input id="rsvp-permission" type="checkbox" name="contact_permission" value="yes"${values.contact_permission === 'yes' ? ' checked' : ''}>
      <label for="rsvp-permission">Optional: Skip Jackson may also contact me by phone or email about Medicare plans.</label>
    </div>
    <div class="hp" aria-hidden="true"><label for="rsvp-website">Leave this field empty</label><input id="rsvp-website" name="website" tabindex="-1" autocomplete="off"></div>
    <input type="hidden" name="form_token" value="${esc(token)}">
    <div class="full">
      <p class="form-note">We’ll use your information only for this event unless you check the box above. It is never sold. See the <a href="/privacy/">privacy policy</a>.</p>
      <button class="btn btn-plum" type="submit">${e.format === 'online' ? 'Sign me up' : 'Reserve my seat'}</button>
    </div>
  </div>
</form>`;
}

function detailFacts(e, { includeJoin = false } = {}) {
  const rows = [
    ['Date', fmtDay(e.starts_at)],
    ['Time', fmtTimeRange(e.starts_at, e.ends_at)],
  ];
  let where2;
  if (e.format === 'online') {
    where2 = includeJoin ? `Online<br><span class="join-info">${esc(e.online_join_info || '').replace(/\n/g, '<br>')}</span>` : 'Online. Use “Get the join link” on this page; signing up is optional.';
  } else {
    where2 = `${esc(e.venue_name || '')}<br>${esc(fullAddress(e))}<br><a href="${esc(mapsUrl(e))}" rel="noopener" target="_blank">Open in Google Maps<span class="visually-hidden"> (opens in a new tab)</span></a>`;
  }
  return `<dl class="event-facts">
  ${rows.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('\n  ')}
  <div><dt>Where</dt><dd>${where2}</dd></div>
  <div><dt>Type</dt><dd>${esc(TYPE_LABEL[e.event_type])}</dd></div>
  ${e.accessibility_notes ? `<div><dt>Accessibility</dt><dd>${esc(e.accessibility_notes)}</dd></div>` : ''}
  ${e.refreshments ? `<div><dt>Refreshments</dt><dd>${esc(e.refreshments)}</dd></div>` : ''}
</dl>`;
}

function breadcrumbs(title) {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/events/">Events</a></li><li><span aria-current="page">${esc(title)}</span></li></ol></nav>`;
}

function joinBox(e) {
  if (e.format !== 'online' || e.status === 'cancelled') return '';
  return `<div class="callout join-box">
  <h2>Join online</h2>
  <p>You don’t need to sign up or give any contact details to join.</p>
  <form method="post" action="/events/${esc(encodeURIComponent(e.slug))}/join"><button class="btn btn-plum btn-sm" type="submit">Get the join link</button></form>
</div>`;
}

function renderDetail(e, { tpmo = '', form = {}, full = false, token = '', preview = false, following = null } = {}) {
  const cancelled = e.status === 'cancelled';
  return `${preview ? `<div class="preview-banner" role="note"><div class="container"><strong>Preview.</strong> ${e.status === 'draft' ? 'This draft is not published. Only signed-in staff can see this page.' : 'This is how the public page looks.'}</div></div>` : ''}
<section class="page-hero" aria-labelledby="page-title">
  <div class="container">
    ${breadcrumbs(e.title)}
    <p class="event-hero-type">${esc(TYPE_LABEL[e.event_type])}${e.format === 'online' ? ' · Online' : ''}</p>
    <h1 id="page-title">${esc(e.title)}</h1>
    <p class="lead">${esc(fmtDay(e.starts_at))}, ${esc(fmtTimeRange(e.starts_at, e.ends_at))}<br>${esc(where(e))}</p>
  </div>
</section>
${tpmo}
<div class="section page-body">
  <div class="container content-grid event-detail">
    <article class="article">
      ${cancelled ? `<div class="callout event-cancelled-callout" role="note"><p><strong>This event is cancelled.</strong> ${esc(e.cancel_reason || '')}</p></div>` : ''}
      ${e.summary ? `<p class="lead">${esc(e.summary)}</p>` : ''}
      ${following ? `<div class="callout event-following" role="note"><p>An optional information and enrollment session follows at ${esc(fmtTimeRange(following.starts_at, null).replace(' Eastern Time', ''))} Eastern Time. You’re welcome to leave before it begins.</p></div>` : ''}
      ${detailFacts(e)}
      ${joinBox(e)}
      ${paras(e.description)}
      ${disclosureBlock(e)}
      ${cancelled ? '' : `<p><a class="text-link" href="/events/${esc(encodeURIComponent(e.slug))}/calendar.ics">Add to my calendar (.ics)</a></p>`}
      <p><a class="text-link" href="/events/">All events</a></p>
    </article>
    <div class="event-rsvp">${rsvpForm(e, { ...form, token, full })}</div>
  </div>
</div>`;
}

function renderSuccess(e, rsvp) {
  const people = 1 + (rsvp.guests || 0);
  return `<section class="page-hero" aria-labelledby="page-title">
  <div class="container">
    ${breadcrumbs(e.title)}
    <h1 id="page-title">You’re signed up</h1>
    <p class="lead">Thank you, ${esc(rsvp.first_name)}. We’ve saved ${people === 1 ? 'a spot for you' : `${people} spots`} at “${esc(e.title)}”.</p>
  </div>
</section>
<div class="section page-body">
  <div class="container">
    <div class="article rsvp-confirm" role="status" tabindex="-1">
      <h2>Your event details</h2>
      ${detailFacts(e, { includeJoin: true })}
      ${disclosureBlock(e)}
      <p><a class="btn btn-plum" href="/events/${esc(encodeURIComponent(e.slug))}/calendar.ics">Add to my calendar</a></p>
      <p>Need to change or cancel? Call <a href="tel:+14043547597">(404) 354-7597</a>.</p>
      <p><a class="text-link" href="/events/">See other events</a></p>
    </div>
  </div>
</div>`;
}

function renderJoin(e) {
  return `<section class="page-hero" aria-labelledby="page-title">
  <div class="container">
    ${breadcrumbs(e.title)}
    <h1 id="page-title">Join “${esc(e.title)}”</h1>
    <p class="lead">${esc(fmtDay(e.starts_at))}, ${esc(fmtTimeRange(e.starts_at, e.ends_at))}</p>
  </div>
</section>
<div class="section page-body">
  <div class="container">
    <div class="article rsvp-confirm">
      <h2>How to join</h2>
      <p class="join-info">${esc(e.online_join_info || '').replace(/\n/g, '<br>')}</p>
      ${disclosureBlock(e)}
      <p>Trouble joining? Call <a href="tel:+14043547597">(404) 354-7597</a>.</p>
      <p><a class="text-link" href="/events/${esc(encodeURIComponent(e.slug))}/">Back to the event</a></p>
    </div>
  </div>
</div>`;
}

function homeSection(events) {
  if (!events.length) return '';
  return `<section class="section section-white events-home" aria-labelledby="events-home-title">
  <div class="container">
    <div class="section-head">
      <p class="kicker">Events across Georgia</p>
      <h2 id="events-home-title">Upcoming events.</h2>
      <p class="lead">Meet Skip in person or online. You don’t have to RSVP to attend in-person events.</p>
    </div>
    <ul class="event-list event-list-compact">
${events.map((e) => eventCard(e, { base: './events/' })).join('\n')}
    </ul>
    <p class="events-accommodation">${esc(ACCOMMODATION)}</p>
    <p><a class="text-link" href="./events/">See all events</a></p>
  </div>
</section>`;
}

/** schema.org Event JSON-LD (safe inside a script tag). No isAccessibleForFree, no offers. */
function jsonLd(e, baseUrl = '') {
  const url = `${baseUrl || ''}/events/${encodeURIComponent(e.slug)}/`;
  const data = {
    '@context': 'https://schema.org', '@type': 'Event', name: e.title, description: e.summary || undefined, url,
    startDate: e.starts_at, endDate: e.ends_at,
    eventStatus: e.status === 'cancelled' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: e.format === 'online' ? 'https://schema.org/OnlineEventAttendanceMode' : 'https://schema.org/OfflineEventAttendanceMode',
    location: e.format === 'online' ? { '@type': 'VirtualLocation', url }
      : { '@type': 'Place', name: e.venue_name, address: { '@type': 'PostalAddress', streetAddress: e.address, addressLocality: e.city, addressRegion: 'GA', postalCode: e.zip || undefined, addressCountry: 'US' } },
    organizer: { '@type': 'Person', name: 'Skip Jackson', jobTitle: 'Licensed Insurance Agent', telephone: '+1-404-354-7597' },
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>`;
}

// ---------------- iCalendar ----------------
function icsText(s) {
  return String(s || '').replace(/\r\n?|\n/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\p{Cf}/gu, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function icsFold(line) {
  const out = [];
  let rest = Buffer.from(line, 'utf8');
  let first = true;
  while (rest.length > (first ? 75 : 74)) {
    let n = first ? 75 : 74;
    while (n > 0 && (rest[n] & 0xc0) === 0x80) n -= 1; // don't split a UTF-8 character
    out.push((first ? '' : ' ') + rest.subarray(0, n).toString('utf8'));
    rest = rest.subarray(n);
    first = false;
  }
  out.push((first ? '' : ' ') + rest.toString('utf8'));
  return out.join('\r\n');
}
function icsLocal(iso) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(iso)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}
const icsUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function ics(e, baseUrl = '') {
  // Absolute links only when PUBLIC_URL is configured (never from the request's Host header).
  const path = `/events/${encodeURIComponent(e.slug)}/`;
  const url = baseUrl ? `${baseUrl}${path}` : null;
  const location = e.format === 'online' ? 'Online (join details are in your RSVP confirmation)' : [e.venue_name, fullAddress(e)].filter(Boolean).join(', ');
  const description = [e.summary, DISCLOSURES[e.event_type], url ? `Details: ${url}` : null, 'Questions: (404) 354-7597'].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Skip Jackson Medicare//Events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:event-${e.id}@skipjackson-medicare`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART;TZID=America/New_York:${icsLocal(e.starts_at)}`,
    `DTEND;TZID=America/New_York:${icsLocal(e.ends_at)}`,
    `SUMMARY:${icsText(e.title)}`,
    `LOCATION:${icsText(location)}`,
    `DESCRIPTION:${icsText(description)}`,
    url ? `URL:${url}` : null,
    `STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.filter(Boolean).map(icsFold).join('\r\n')}\r\n`;
}

module.exports = { esc, paras, renderList, renderDetail, renderSuccess, renderJoin, homeSection, jsonLd, ics, eventCard, fmtDay, fmtTimeRange, gaDate, EMPTY };
