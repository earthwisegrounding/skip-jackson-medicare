'use strict';
// Statewide events: validation, Medicare marketing compliance rules, queries and RSVPs.
//
// Rules follow the CMS Medicare Communications & Marketing Guidelines (42 CFR 422.2260-2274) as
// amended by the CY2027 final rule (CMS-4212-F). They run as a live checklist while editing and are
// enforced whenever an event becomes (or stays) publicly visible: publish, cancel, admin edits.

const crypto = require('node:crypto');
const { T, validate } = require('./validate');
const { insert, update } = require('./db');
const { zonedParts } = require('./time');
const C = require('./constants');
const S = require('./services');

const EVENT_TYPES = [['educational', 'Educational session'], ['marketing', 'Information and enrollment session']];
const FORMATS = [['in_person', 'In person'], ['online', 'Online']];
const HEALTHCARE_SETTINGS = [['no', 'Not in a healthcare setting'], ['common_area', 'Common area of a healthcare setting (lobby, cafeteria, community room)'], ['patient_care_area', 'Patient care area (exam/treatment rooms, pharmacy counter, waiting areas)']];
const EVENT_STATUS = [['draft', 'Draft'], ['published', 'Published'], ['cancelled', 'Cancelled']];

// Required public disclosures, appended automatically (never editable by staff).
const DISCLOSURES = {
  marketing: 'A licensed insurance agent will be present with information and applications. For accommodation of persons with special needs at sales meetings, call (404) 354-7597 (TTY 711).',
  educational: 'This is an educational event. No plan-specific benefits or details will be shared, and no enrollment applications will be taken. For accommodations, call (404) 354-7597 (TTY 711).',
};
// 42 CFR 422.2267(e)(35): shown on every advertisement of events (list pages too).
const ACCOMMODATION = 'For accommodation of persons with special needs at events, call (404) 354-7597 (TTY 711).';
const PAIRING_WARNING = 'When a sales event follows an educational event, announce that the educational event is ending and give people a chance to leave before the sales event starts.';
const PAIRING_ACK = 'I’ll announce when the educational session ends and give people a chance to leave before the sales session starts.';
const GIFTS_ACK = 'Any gifts are worth $15 or less each, are offered to everyone whether or not they enroll, and raffle entries won’t be used for marketing.';
const SEAT_CAP_PER_IP = 6;
const RETENTION_DAYS = 90;

const keys = (pairs) => pairs.map(([k]) => k);

const eventSchema = {
  title: { type: T.cleanString(90), required: true, label: 'Title' },
  event_type: { type: T.enum(keys(EVENT_TYPES)), required: true, label: 'Event type' },
  starts_at: { type: T.datetime(), label: 'Start' },
  ends_at: { type: T.datetime(), label: 'End' },
  format: { type: T.enum(keys(FORMATS)), default: 'in_person' },
  venue_name: { type: T.cleanString(120) },
  address: { type: T.cleanString(200) },
  city: { type: T.cleanString(80) },
  county: { type: T.cleanString(80) },
  zip: { type: T.zip() },
  online_join_info: { type: T.cleanText(1000) },
  summary: { type: T.cleanText(200) },
  description: { type: T.cleanText(3000) },
  accessibility_notes: { type: T.cleanText(500) },
  capacity: { type: T.int(1, 5000) },
  rsvp_enabled: { type: T.bool(), default: 1 },
  healthcare_setting: { type: T.enum(keys(HEALTHCARE_SETTINGS)), default: 'no' },
  carrier_submitted: { type: T.bool(), default: 0 },
  carrier_refs: { type: T.cleanText(500) },
  refreshments: { type: T.cleanString(200) },
  gifts_ack: { type: T.bool(), default: 0 },
  pairing_ack: { type: T.bool(), default: 0 },
};

const rsvpSchema = {
  first_name: { type: T.cleanString(60), required: true, requiredMessage: 'Please enter your first name.', label: 'First name' },
  last_name: { type: T.cleanString(60), required: true, requiredMessage: 'Please enter your last name.', label: 'Last name' },
  phone: { type: T.phone() },
  email: { type: T.email() },
  guests: { type: T.int(0, 5), default: 0 },
  needs_accommodation: { type: T.cleanText(300) },
  contact_permission: { type: T.enum(['yes'], 'Invalid value.') },
};

// ---------------- Text normalization for the wording lint ----------------
// Common Cyrillic/Greek look-alikes (lower-case) mapped to ASCII.
const HOMOGLYPHS = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ϳ: 'j', ϱ: 'p', ω: 'w', ѵ: 'v',
};
function normalizeText(s) {
  return String(s || '').normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase()
    .replace(/[^\x00-\x7f]/g, (ch) => HOMOGLYPHS[ch] || ch)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‛]/g, "'").replace(/[‐-―]/g, '-');
}
/**
 * "Squashed" variants for evasion like "f r e e", "f.r.e.e", "b-e-s-t": each word with punctuation
 * removed, and runs of 1-2 letter fragments joined. Only compared to whole terms (no "freedom" hits).
 */
function squashedTokens(norm) {
  const exact = new Set();
  const runs = [];
  for (const line of norm.split('\n')) {
    let run = '';
    let singles = '';
    const flush = () => { if (run.length > 2) exact.add(run); if (singles.length > 3) runs.push(singles); run = ''; singles = ''; };
    for (const w of line.split(/\s+/).filter(Boolean)) {
      const bare = w.replace(/[^a-z0-9$#]/g, '');
      if (!bare) continue;
      exact.add(bare);
      if (bare.length <= 2) run += bare; else { flush(); continue; }
      if (bare.length === 1) singles += bare; else { if (singles.length > 3) runs.push(singles); singles = ''; }
    }
    flush();
  }
  // exact: whole words / joined short fragments ("fr ee"); runs: spelled-out letters ("f r e e"), searched for terms.
  return { has: (t) => exact.has(t) || runs.some((r) => r.includes(t)) };
}

// [pattern on normalized text, label, squashed exact terms]
const PROHIBITED = [
  [/\bfree(bies?)?\b/, 'free', ['free', 'freebie', 'freebies']],
  [/\bno[\s-]?charge\b/, 'no charge'], [/\bno[\s-]cost\b/, 'no cost'], [/\bat no cost\b/, 'at no cost'],
  [/\bzero[\s-]?(dollar\s+)?premiums?\b/, 'zero premium'],
  [/\$\s?0(\.0+)?(?![\d.,]*\d)/, '$0', ['$0', '$000']],
  [/\bbest\b/, 'best', ['best']], [/#\s?1\b/, '#1', ['#1']], [/\bno\.?\s?1\b/, 'No. 1'], [/\bnumber[\s-]one\b/, 'number one'],
  [/\b(highest|top)[\s-]?rated\b/, 'top/highest rated'],
  [/\bguarantee(d|s)?\b/, 'guarantee'],
  [/\bmedicare[\s-]approved\b/, 'Medicare approved'], [/\bcms[\s-]approved\b/, 'CMS approved'], [/\bendorse(d|s|ment)?\b/, 'endorsed'],
  [/\bgovernment\b/, 'government'], [/\bofficial(ly)?\b/, 'official'], [/\bfederal\b/, 'federal'], [/\bstate[\s-]sponsored\b/, 'state-sponsored'],
  [/\bsocial security (office|administration)\b/, 'Social Security office/Administration'],
  [/\bmedicare\s+(information\s+|help\s+)?(center|office|hotline|program)s?\b/, 'official-sounding Medicare name (center/office/hotline/program)'],
];
const MEALS = [
  [/\b(pizzas?|sandwich(es)?|suppers?|bbq|barbecue|hot food|meals?|lunch(es|eons?)?|dinners?|breakfasts?|brunch(es)?|buffets?|catered|catering|potlucks?|free food)\b/, 'meal',
    ['lunch', 'dinner', 'buffet', 'pizza', 'supper', 'brunch', 'breakfast', 'meal']],
];
const GIFT_WORDS = /\b(gifts?|gift cards?|giveaways?|raffles?|door prizes?|drawings?|prizes?|swag)\b/;
const CASH = [[/\bcash\b/, 'cash'], [/\bvisa gift cards?\b/, 'Visa gift card'], [/\bprepaid (debit |gift )?cards?\b/, 'prepaid card'], [/\bgift cards?\b/, 'gift card (cash equivalent)']];
const EDU_SALES = [
  [/\benroll(s|ed|ing)?\b/, 'enroll'],
  [/(?<!\b(annual|open|general|special|initial|advantage)\s)\benrollments?\b(?!\s+periods?\b)/, 'enrollment (as a call to action)'],
  [/\benrollment applications?\b/, 'enrollment application'], [/\bapply\b/, 'apply'], [/\bapplications?\b/, 'applications'],
  [/\bswitch(ing)?\s+(your\s+)?plans?\b/, 'switch plans'], [/\bget\s+a\s+quote\b/, 'get a quote'], [/\bsign(ing)?\s+up\s+for\s+(a\s+)?(plan|coverage)\b/, 'sign up for a plan/coverage'],
  [/\bcompar(e|ing)\s+(the\s+)?plans\b|\bplan comparisons?\b/, 'compare plans'],
  [/\bplan benefits\b/, 'plan benefits'], [/\bpremiums?\b/, 'premium'], [/\$\s?\d/, '$ amounts'],
];
const CARRIER_PATTERNS = [
  ['Humana', /\bhumana\b/, ['humana']], ['HealthSpring', /\bhealth\s?spring\b/, ['healthspring']], ['Aetna', /\baetna\b/, ['aetna']],
  ['UnitedHealthcare', /\b(united\s?health\s?care|uhc)\b/, ['unitedhealthcare', 'uhc']], ['Wellcare', /\bwell\s?care\b/, ['wellcare']],
  ['Devoted Health', /\bdevoted\s+health\b/, ['devotedhealth']], ['Anthem', /\banthem\b/, ['anthem']],
  ['Blue Cross Blue Shield', /\bblue\s?cross\b|\bblue\s?shield\b|\bbcbs\b/, ['bluecross', 'blueshield', 'bcbs']], ['Cigna', /\bcigna\b/, ['cigna']],
  ['Kaiser', /\bkaiser\b/, ['kaiser']], ['CareSource', /\bcare\s?source\b/, ['caresource']], ['Alignment Health', /\balignment\s+health\b/, ['alignmenthealth']],
  ['Amerigroup', /\bamerigroup\b/, ['amerigroup']], ['Peach State', /\bpeach\s+state\b/, ['peachstate']], ['Clover Health', /\bclover\s+health\b/, ['cloverhealth']],
  ['AARP', /\baarp\b/, ['aarp']], ['Ambetter', /\bambetter\b/, ['ambetter']], ['Mutual of Omaha', /\bmutual of omaha\b/, ['mutualofomaha']],
  ['Zing Health', /\bzing\b/, ['zinghealth']], ['SCAN Health Plan', /\bscan health\b/, ['scanhealth']],
];
for (const name of C.CARRIERS) {
  if (name === 'Other') continue;
  const norm = name.toLowerCase().replace(/[^a-z]/g, '');
  if (!CARRIER_PATTERNS.some(([, , sq]) => sq.includes(norm))) CARRIER_PATTERNS.push([name, new RegExp(`\\b${name.toLowerCase().replace(/\s+/g, '\\s?')}\\b`), [norm]]);
}

// Every field that can appear on a public page, calendar file or confirmation.
const PUBLIC_FIELDS = ['title', 'summary', 'description', 'refreshments', 'venue_name', 'address', 'city', 'accessibility_notes', 'cancel_reason', 'online_join_info'];

function scan(list, norm, squashed) {
  const found = new Set();
  for (const [re, label, terms] of list) {
    if (re.test(norm)) found.add(label);
    else if (terms && terms.some((t) => squashed.has(t))) found.add(label);
  }
  return [...found];
}
function lintText(e, fields = PUBLIC_FIELDS) {
  const norm = normalizeText(fields.map((f) => e[f] || '').join('\n'));
  return { norm, squashed: squashedTokens(norm) };
}

/** Dollar amounts over $15 within a few words of a gift word. */
function bigGiftAmounts(norm) {
  const hits = [];
  const re = /\$\s?(\d[\d,]*(\.\d+)?)/g;
  let m;
  while ((m = re.exec(norm))) {
    const amount = Number(m[1].replace(/,/g, ''));
    const around = norm.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    if (amount > 15 && GIFT_WORDS.test(around)) hits.push(m[0]);
  }
  return hits;
}

/** Georgia calendar date (YYYY-MM-DD) of an ISO instant. */
function gaDate(iso) {
  const p = zonedParts(new Date(iso));
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

const ADDRESS_WORDS = {
  street: 'st', road: 'rd', avenue: 'ave', drive: 'dr', boulevard: 'blvd', highway: 'hwy', parkway: 'pkwy', lane: 'ln', court: 'ct', circle: 'cir',
  place: 'pl', suite: 'ste', building: 'bldg', north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  apartment: 'apt', number: '#', unit: 'unit', floor: 'fl', terrace: 'ter', trail: 'trl', square: 'sq', mount: 'mt', saint: 'st', expressway: 'expy', freeway: 'fwy',
};
function normalizeAddress(s) {
  return normalizeText(s).replace(/[.,#]/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean)
    .map((w) => ADDRESS_WORDS[w] || w).join(' ');
}
const venueKey = (e) => `${normalizeAddress(e.address)}|${normalizeAddress(e.city)}`;

/** Other (non-cancelled) in-person events of the opposite type at the same venue on the same Georgia day. */
function sameDayPairs(db, e) {
  if (!e.starts_at || e.format !== 'in_person' || !e.address || !e.city) return [];
  const day = gaDate(e.starts_at);
  const rows = db.prepare(`SELECT id, title, event_type, status, starts_at, ends_at, address, city FROM events
    WHERE status != 'cancelled' AND format = 'in_person' AND event_type != ? AND id != ? AND starts_at BETWEEN ? AND ?`)
    .all(e.event_type, e.id || 0, new Date(Date.parse(e.starts_at) - 36 * 3600e3).toISOString(), new Date(Date.parse(e.starts_at) + 36 * 3600e3).toISOString());
  return rows.filter((x) => gaDate(x.starts_at) === day && venueKey(x) === venueKey(e));
}

/**
 * Compliance checklist for an event (saved or not).
 * Returns { rules: [{id, label, ok, level: 'block'|'warn'|'info', message}], blockers, warnings, ok }.
 * `purpose: 'cancel'` skips the start-time rules (a past or imminent event can still be cancelled).
 */
function checkEvent(e, { db = null, now = Date.now(), purpose = 'publish' } = {}) {
  const rules = [];
  const add = (id, label, ok, level, message) => rules.push({ id, label, ok, level, message: ok ? null : message });
  const marketing = e.event_type === 'marketing';
  const online = e.format === 'online';
  const { norm, squashed } = lintText(e);

  add('title', 'Has a title', Boolean(e.title), 'block', 'Add a title.');
  add('type', 'Event type chosen', Boolean(DISCLOSURES[e.event_type]), 'block', 'Choose educational or information-and-enrollment (sales).');
  add('times', 'Start and end times set', Boolean(e.starts_at && e.ends_at && Date.parse(e.ends_at) > Date.parse(e.starts_at)), 'block',
    'Set a start and an end time (the end must be after the start).');
  if (purpose !== 'cancel') add('future', 'Starts in the future', Boolean(e.starts_at && Date.parse(e.starts_at) > now), 'block', 'The start time has already passed.');
  add('summary', 'Short summary written', Boolean(e.summary), 'block', 'Add a short summary (shown on the events list).');
  if (online) add('join', 'Online join details entered', Boolean(e.online_join_info), 'block', 'Add the link or dial-in. Anyone can get it from the event page without signing up.');
  else add('venue', 'Venue, address and city entered', Boolean(e.venue_name && e.address && e.city), 'block', 'Add the venue name, street address and city.');
  add('disclosure', 'Required disclosure added automatically', true, 'info', null);

  if (marketing) {
    add('carrier', 'Submitted to the insurance companies', Boolean(e.carrier_submitted), 'block',
      'Check the box confirming you’ve submitted this event to the insurance companies whose plans you’ll discuss, as their agent policies require.');
    add('setting', 'Not in a patient care area', e.healthcare_setting !== 'patient_care_area', 'block',
      'Sales events can’t be held where patients receive care (exam rooms, pharmacy counters, waiting areas). Common areas such as a lobby, cafeteria or community room are OK.');
    const meals = scan(MEALS, norm, squashed);
    add('meals', 'No meals offered', !meals.length, 'block', 'Meals can’t be provided at sales events. Light refreshments or snacks are fine.');
  } else if (e.event_type === 'educational') {
    const found = scan(EDU_SALES, norm, squashed);
    const carriers = scan(CARRIER_PATTERNS.map(([name, re, sq]) => [re, name, sq]), norm, squashed);
    add('edu_sales', 'No sales language or company names (educational event)', !found.length && !carriers.length, 'block',
      `Educational events can’t promote specific plans or companies, or ask people to enroll. Remove: ${[...found, ...carriers].join(', ')}.`);
    if (e.healthcare_setting === 'patient_care_area') {
      add('edu_setting', 'Educational event in a patient care area', false, 'warn', 'Consider a common area instead, so patients aren’t approached where they receive care.');
    }
  }
  const banned = scan(PROHIBITED, norm, squashed);
  add('wording', 'No prohibited wording', !banned.length, 'block', `Medicare marketing rules don’t allow these words in event listings: ${banned.join(', ')}.`);

  if (GIFT_WORDS.test(norm)) {
    const cash = scan(CASH, norm, squashed);
    const big = bigGiftAmounts(norm);
    add('gift_cash', 'No cash or cash-equivalent gifts', !cash.length && !big.length, 'block',
      `Gifts must be worth $15 or less and can’t be cash or cash equivalents. Remove: ${[...cash, ...big].join(', ')}.`);
    add('gifts_ack', 'Gift rules confirmed', Boolean(e.gifts_ack), 'block', `Check the box: “${GIFTS_ACK}”`);
  }
  if (/\bmedicare seminar\b/.test(norm) && !/licensed insurance agent/.test(normalizeText(e.title))) {
    add('seminar_title', 'Title identifies who is presenting', false, 'warn', 'Consider adding “with Skip Jackson, licensed insurance agent” to the title.');
  }
  if (db) {
    const pairs = sameDayPairs(db, e);
    if (pairs.length) {
      add('pairing', 'Same-day educational + sales event at this venue', false, 'warn', `${PAIRING_WARNING} (Also at this venue that day: ${pairs.map((x) => x.title).join('; ')}.)`);
      add('pairing_ack', 'Hand-off announcement confirmed', Boolean(e.pairing_ack), 'block', `Check the box: “${PAIRING_ACK}”`);
    }
  }
  const blockers = rules.filter((r) => !r.ok && r.level === 'block');
  const warnings = rules.filter((r) => !r.ok && r.level === 'warn');
  return { rules, blockers, warnings, ok: blockers.length === 0 };
}

function slugify(s) {
  let out = String(s || 'event').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > 60) {
    out = out.slice(0, 61);
    const cut = out.lastIndexOf('-');
    out = out.slice(0, cut > 20 ? cut : 60);
  }
  return out.replace(/-+$/, '') || 'event';
}
function makeSlug(db, e) {
  const base = `${slugify(e.title)}${e.starts_at ? `-${gaDate(e.starts_at)}` : ''}`;
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM events WHERE slug = ? AND id != ?').get(slug, e.id || 0); i += 1) slug = `${base}-${i}`;
  return slug;
}

function validateEvent(input, { partial = false } = {}) {
  return validate(eventSchema, input, { partial });
}

/** Seats taken by verified "going" RSVPs (each RSVP counts the person plus guests). */
function seatsTaken(db, eventId, { exceptId = 0 } = {}) {
  return db.prepare("SELECT COALESCE(SUM(1 + guests), 0) AS n FROM event_rsvps WHERE event_id = ? AND status = 'going' AND verified = 1 AND id != ?").get(eventId, exceptId).n;
}

// Public visibility: published, or cancelled while it was published. Never drafts (even previously published ones).
const PUBLIC_SQL = "(e.status = 'published' OR (e.status = 'cancelled' AND e.public_cancel = 1))";

function publicEvents(db, { city = null, format = null, limit = 200, now = new Date(), includeCancelled = true } = {}) {
  const where = [includeCancelled ? PUBLIC_SQL : "e.status = 'published'", 'e.ends_at > :now'];
  const p = { now: now.toISOString(), limit };
  if (city) { where.push('lower(e.city) = lower(:city)'); p.city = city; }
  if (format) { where.push('e.format = :format'); p.format = format; }
  return db.prepare(`SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY e.starts_at LIMIT :limit`).all(p);
}
function publicEventBySlug(db, slug, now = new Date()) {
  const e = db.prepare(`SELECT e.* FROM events e WHERE e.slug = ? AND ${PUBLIC_SQL}`).get(slug);
  if (!e || Date.parse(e.ends_at) <= now.getTime()) return null;
  return e;
}
/** Published sales event that follows an educational event at the same venue the same day. */
function followingSalesEvent(db, e) {
  if (e.event_type !== 'educational') return null;
  return sameDayPairs(db, e).filter((x) => x.status === 'published' && Date.parse(x.starts_at) >= Date.parse(e.starts_at))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] || null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Store (or update) an RSVP.
 * - One RSVP per event per phone/email: a repeat updates the existing one.
 * - Only an explicit contact_permission creates/links a CRM contact (normal lead pipeline: dedupe, household,
 *   DNC and suppression rules apply; no text consent is collected).
 * - Returns { id, contactId, confirmToken } - the token unlocks the confirmation page for 24 hours.
 */
function storeRsvp(db, event, v, { ip = null, userAgent = null, origin = null, verified = true, verifyReason = null, browserHeaders = true, storeLead, existingId = null }) {
  const now = S.nowIso();
  const confirmToken = crypto.randomBytes(24).toString('base64url');
  const confirm = { confirm_hash: sha256(confirmToken), confirm_expires_at: new Date(Date.now() + 24 * 3600e3).toISOString() };
  let id = existingId;
  if (id) {
    const old = db.prepare('SELECT * FROM event_rsvps WHERE id = ?').get(id);
    update(db, 'event_rsvps', id, {
      guests: v.guests || 0, needs_accommodation: v.needs_accommodation || old.needs_accommodation, first_name: v.first_name, last_name: v.last_name,
      phone: v.phone || old.phone, email: v.email || old.email, contact_permission: v.contact_permission === 'yes' || old.contact_permission ? 1 : 0,
      verified: old.verified || verified ? 1 : 0, ...confirm,
    });
  } else {
    id = insert(db, 'event_rsvps', {
      event_id: event.id, first_name: v.first_name, last_name: v.last_name, phone: v.phone, email: v.email, guests: v.guests || 0,
      needs_accommodation: v.needs_accommodation, contact_permission: v.contact_permission === 'yes' ? 1 : 0, verified: verified ? 1 : 0,
      ip, user_agent: userAgent, origin, status: 'going', created_at: now, ...confirm,
    });
  }
  let contactId = null;
  if (v.contact_permission === 'yes') {
    contactId = storeLead(db, {
      first_name: v.first_name, last_name: v.last_name, phone: v.phone, email: v.email, topic: 'other',
      preferred_contact: v.phone ? 'phone' : 'email', message: `RSVP for “${event.title}” on ${gaDate(event.starts_at)}. Gave permission to be contacted about Medicare plans.`,
      form_id: 'event-rsvp', source_page: `/events/${event.slug}/`,
    }, { ip, userAgent, origin, verified, verifyReason, browserHeaders, source: 'event' });
    update(db, 'event_rsvps', id, { contact_id: contactId });
  }
  S.audit(db, { action: existingId ? 'rsvp_update' : 'rsvp_create', entity: 'event', entityId: event.id,
    summary: `rsvp=${id}; guests=${v.guests || 0}; permission=${contactId ? 'yes' : 'no'}; verified=${verified ? 'yes' : 'no'}`, ip });
  return { id, contactId, confirmToken };
}

function rsvpByConfirmToken(db, eventId, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const r = db.prepare("SELECT * FROM event_rsvps WHERE event_id = ? AND confirm_hash = ? AND status = 'going'").get(eventId, sha256(token));
  if (!r || !r.confirm_expires_at || Date.parse(r.confirm_expires_at) < Date.now()) return null;
  return r;
}

/** Clear contact details from event-only RSVPs 90 days after the event ends (counts are kept). */
function anonymizeOldRsvps(db, now = Date.now()) {
  const cutoff = new Date(now - RETENTION_DAYS * 864e5).toISOString();
  const info = db.prepare(`UPDATE event_rsvps SET first_name = 'Removed', last_name = '', phone = NULL, email = NULL, needs_accommodation = NULL,
      ip = NULL, user_agent = NULL, origin = NULL, confirm_hash = NULL, anonymized_at = ?
    WHERE contact_permission = 0 AND anonymized_at IS NULL AND event_id IN (SELECT id FROM events WHERE ends_at < ?)`).run(new Date(now).toISOString(), cutoff);
  if (info.changes) S.audit(db, { action: 'retention', entity: 'event_rsvps', summary: `anonymized ${info.changes} event-only RSVP(s) older than ${RETENTION_DAYS} days` });
  return Number(info.changes);
}

module.exports = {
  EVENT_TYPES, FORMATS, HEALTHCARE_SETTINGS, EVENT_STATUS, DISCLOSURES, ACCOMMODATION, PAIRING_WARNING, PAIRING_ACK, GIFTS_ACK, SEAT_CAP_PER_IP, RETENTION_DAYS,
  eventSchema, rsvpSchema, PUBLIC_FIELDS, checkEvent, sameDayPairs, makeSlug, slugify, validateEvent, seatsTaken, publicEvents, publicEventBySlug,
  followingSalesEvent, storeRsvp, rsvpByConfirmToken, anonymizeOldRsvps, gaDate, normalizeText, normalizeAddress, squashedTokens, sha256,
};
