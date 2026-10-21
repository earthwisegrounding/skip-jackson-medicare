# Skip Jackson, Medicare broker — website + CRM

One small Node.js process serves:

| Path | What |
|---|---|
| `/` | The public website (static files in `public/`) |
| `POST /api/leads` | Lead intake from the website forms (JSON or plain form posts) |
| `GET /api/form-token` | Signed form token for the website forms (`{token, issued_at}`); sent back as the `form_token` field |
| `/events/`, `/events/<slug>/` | Server-rendered events listing and event pages (RSVP form posts to `/events/<slug>/rsvp`; `.ics` at `/events/<slug>/calendar.ics`) |
| `/login`, `/staff` | Shortcuts that redirect to `/crm/` |
| `/crm/` | The admin CRM (single-page app in `crm/`) |
| `/crm/api/*` | The CRM's JSON API |

There are **no third-party dependencies**: only Node's built-in `http`, `sqlite`, `crypto`, `fs` and `test` modules. Requires **Node 25+**.

## Run it locally

```sh
npm start                 # http://localhost:8790  (data in ./data)
PORT=9000 DATA_DIR=/tmp/crm npm start
npm test                  # runs the full test suite against a temporary database
```

### Create the first user

There is no default password. Create an admin from the command line (you'll be asked for a password, at least 12 characters):

```sh
npm run create-user -- --email skip@example.com --name "Skip Jackson" --role admin
```

- Non-interactive (e.g. on a server), recommended: pipe the password on stdin so it never lands in shell history or the process environment:
  `printf '%s' "$PASSWORD" | npm run create-user -- --email … --name … --role admin --password-stdin`
  (`CRM_PASSWORD=…` also works as a fallback, but environment variables can leak to other processes and logs.)
- Forgot a password or locked out: `npm run create-user -- --email skip@example.com --reset`. A deactivated account stays deactivated unless you add `--activate`.
- More users (an assistant with the **agent** role) can be added in the CRM under **Settings → Users**.

Agents can do day-to-day work (contacts, notes, calls, tasks, appointments, SOAs, policies, consents, archive). Only admins can export, permanently delete, delete SOAs/policies, manage users and settings, and see reports and the audit log.

### Demo data

```sh
DATA_DIR=./data-demo npm run seed:demo
DATA_DIR=./data-demo CRM_PASSWORD='a-long-demo-password' npm run seed:demo   # also creates admin@example.com + assistant@example.com
DATA_DIR=./data-demo npm start
```

Demo data is obviously fake (555-01xx phone numbers, `example.com` emails, names like "Dora Demo"). The script refuses to run against the default `./data` folder unless you pass `--force`, and refuses to add to a database that already has contacts.

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8790` | |
| `DATA_DIR` | `./data` | SQLite database lives here (`crm.db`). Must be on a persistent disk. |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy/load balancer so the real client IP and HTTPS (`X-Forwarded-Proto`) are used. Leave off when not behind a proxy, or rate limits can be bypassed. |
| `TRUST_PROXY_HOPS` | `1` | Number of proxies in front of the app. The client IP is read from the **right** of `X-Forwarded-For` (entry number `TRUST_PROXY_HOPS` from the end); anything to the left is client-supplied and ignored. Example: Cloudflare → nginx → app = `2`. |
| `TRUSTED_CLIENT_IP_HEADER` | — | If your platform sets a single trusted client-IP header, name it here instead (e.g. `Fly-Client-IP`, `CF-Connecting-IP`). Only used with `TRUST_PROXY=1`; invalid values fall back to the socket address. |
| `LEAD_FAIL_LIMIT_10MIN` | 20 | Website form validation failures per IP (separate from accepted submissions, so typos don't lock people out). |
| `LOGIN_LIMIT_15MIN` / `LOGIN_EMAIL_LIMIT_15MIN` | 30 / 20 | Sign-in attempts per IP and per email address. |
| `RATE_LIMIT_MAX_KEYS` | 50000 | Memory bound for each in-memory rate limiter (oldest keys evicted). IPv6 clients are grouped by /64. |
| `COOKIE_SECURE` | off | Set `1` in production to always mark the session cookie `Secure`. |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | 30 / 12 | |
| `LEAD_LIMIT_10MIN` / `LEAD_LIMIT_DAILY` | 5 / 20 | Website form submissions per IP. |
| `PUBLIC_URL` | — | **Set this in production**, e.g. `https://example.com` (the deploy script does). Used for absolute links in event JSON-LD and calendar files. When unset, those links are relative; the request's Host header is never used. |
| `CRM_TIMEZONE` | `America/New_York` | Used for "today", business days and AEP dates. |
| `BACKUP_DIR` | `./backups` | Where `npm run backup` writes. |

## Deploying

Any host that runs Node 25 and has a **persistent disk** works (a small VPS, Render/Railway/Fly.io with a volume, etc.). SQLite is a single file, so run **one** instance.

1. **TLS is required.** Put the app behind HTTPS (Caddy, nginx, or your platform's load balancer). Never serve the CRM over plain HTTP.
2. Set `COOKIE_SECURE=1` and, behind a proxy, `TRUST_PROXY=1`. HSTS is sent automatically on HTTPS requests.
3. Set `DATA_DIR` to the persistent volume and create the first admin with `npm run create-user`.
4. Docker: `docker build -t skip-medicare .` then
   `docker run -d -p 8790:8790 -v skip-data:/data -e COOKIE_SECURE=1 -e TRUST_PROXY=1 skip-medicare`
   and `docker exec -it <container> node scripts/create-user.js --email … --name … --role admin`.
   The image runs as a non-root user and stores everything in the `/data` volume.
5. The server shuts down gracefully on `SIGTERM`/`SIGINT` (finishes in-flight requests, closes the database).
6. Logs are one JSON line per request: method, path (no query string), status and milliseconds. Request bodies and personal information are never logged.

## Backups

```sh
npm run backup            # -> backups/crm-YYYYMMDD-HHMMSS.db (UTC timestamp)
```

This uses SQLite's `VACUUM INTO`, which produces a consistent copy while the app is running, then runs an integrity check. Backup files are created readable only by the app's user (mode 0600). Point `BACKUP_DIR` at a **different disk/volume** from `DATA_DIR`, so one failure can't take out both. Schedule it daily (cron or your platform's scheduler), copy backups **off the server** to encrypted storage, and test a restore now and then (stop the app, replace `DATA_DIR/crm.db` with a backup, start the app). Backups contain personal information — protect them like the live database.

## Data retention

- **Enrollment and other Medicare-related records** (contacts, SOAs, policies/enrollments, consent and contact-request records, the audit log): keep generally **10 years**.
- **Call recordings** of Medicare Advantage / Part D marketing and sales calls (including video meetings) must be kept **at least 6 years** (42 CFR 422.2274(g)(2)(ii), as amended). Recordings are stored in your phone/recording system, not in this CRM; the CRM only records *that* a call was recorded.
- Use **Archive** for people you no longer work with. **Permanent delete** is admin-only and requires typing the person's full name. It removes the person's timeline, tasks, appointments, SOAs and policies and clears their name and contact details everywhere, but keeps the append-only compliance evidence in anonymized form: the consent/opt-out history (with phone, email, IP and browser removed), website-request records, and the audit log. Opt-outs are also kept on a suppression list keyed by a SHA-256 hash of the phone/email, so if the same person is added again later they stay opted out. (A hash of a phone number can be reversed by brute force; it limits casual exposure, it is not encryption.)
- A website request gives permission to contact the person about the topics they asked about for **12 months** (42 CFR 422.2264(c)(3)(iii)). The dashboard lists people whose permission has expired without enrolling; nothing is deleted automatically.

## Events

Skip's in-person and online events are managed in the CRM (**Events**) and published to the website.

- **Public pages are rendered by the server** (they work without JavaScript, and search engines will be able to read them once the site's `noindex` tag is removed at launch): `/events/` lists upcoming events by month with a city/format filter; each event has its own page with details, a Google Maps link, an add-to-calendar `.ics` file, the required disclosure, schema.org Event data, and an RSVP form. The home page shows the next three events after "How it works" (the static copy shows nothing there). Past events never appear; cancelled upcoming events show "Cancelled" with the reason until their date passes. Drafts are visible only to signed-in staff through **Preview**.
- **Online join details** aren't printed on the listing, event page or calendar file. Anyone can get them with the **Get the join link** button (no contact details needed — 42 CFR 422.2264(c)(2) doesn't allow requiring them); the join page is `noindex`/`no-store`. People who RSVP also see them on their confirmation page.
- **RSVPs** are optional for in-person events. Contact details are used only for that event unless the person ticks the optional box "Skip Jackson may also contact me by phone or email about Medicare plans"; only then is a CRM contact created or linked (through the normal website-request rules: matching, household, do-not-contact and opt-out list). No text-message consent is collected from RSVPs. Capacity is enforced; spam protection matches the contact form (signed form token embedded in the page, honeypot, same-origin check, rate limits). Sign-ups without a valid token or browser Origin are kept as **unverified** and don't use up seats. One RSVP per person per event (a repeat with the same phone or email updates the first), at most 6 seats per network address per event, and sign-up closes when the event starts. After signing up, people are redirected to a confirmation page whose link works for 24 hours (refreshing never re-submits).
- **Retention:** RSVPs from people who didn't ask to be contacted lose their name, phone, email and notes 90 days after the event (checked at startup and daily); seat counts are kept.
- **Compliance checks** run live in the editor and are enforced when publishing (CMS Medicare Communications & Marketing Guidelines as amended by CMS-4212-F): the correct disclosure is added automatically for educational vs. information-and-enrollment (sales) events; sales events need the "submitted to the insurance companies" confirmation, can't be in a patient care area, and can't offer meals; prohibited wording (e.g. "free", "no cost", "$0", "zero premium", "best", "#1", "top-rated", "guarantee", "Medicare/CMS approved", "endorsed", "government", "official", "federal", "Social Security office", official-sounding "Medicare … center/office/hotline/program") is blocked on all events — checked across every public field (title, summary, description, refreshments, venue, address, city, accessibility notes, cancellation reason, join details) after normalizing look-alike characters, zero-width characters and spaced-out letters; educational events can't use sales calls-to-action or name any insurance company; gifts/raffles need a "$15 or less, offered to everyone" confirmation and can't be cash or gift cards; when an educational and a sales event share a venue on the same day, publishing needs a hand-off confirmation and the educational page tells people they may leave before the sales session. Every list of events also carries the accommodation statement. Unpublishing removes an event from the site entirely; cancelling a published event (which keeps it visible as "Cancelled") re-runs every check, including on the reason. Admins publish, unpublish, cancel, delete drafts and mark RSVPs cancelled; agents can create and edit events that have never been published and see RSVPs. Published and cancelled events are kept for records. RSVP lists export to CSV (admin). Two printouts: a blank, optional sign-in sheet for the table (with an "OK to contact me" column — no names pre-printed) and a staff-only check-in list with RSVP names.

## Medicare-specific behaviour

- **Scope of Appointment (SOA):** under the CY2027 final rule (CMS-4212-F, applicable to marketing from Oct 1, 2026) the 48-hour waiting period is gone. The SOA must be documented **before** the personal marketing appointment starts (the same day is fine). Each appointment shows: **OK**, **SOA missing**, **SOA recorded after appointment start**, **In-person appointment needs a written SOA** (verbal SOA used for an in-person meeting), or **SOA older than 12 months**. SOAs can't be deleted by agents; admin deletes require a reason and are logged.
- **Website requests** are stored as beneficiary-initiated contact requests (permission to contact), with time, IP, browser, Origin/Referer, form, page and the name it was submitted under.
- **Matching:** a website request is attached to an existing contact only if the phone or email matches **and** the first and last name match (ignoring case and accents). It never changes that contact's details, never un-archives them (a review task is created instead) and never moves a do-not-contact person back to "New". A request that shares a phone/email with someone of a different name creates a separate contact flagged **possible household member — review**.
- **Website consent review:** the checkbox consent is in effect immediately only for a clean request. It is recorded but **held for review** (not in effect) when the person is do-not-contact, the phone differs from the contact's phone, the match was by email only, the phone/email is shared with another contact, that number previously opted out, the request lacked a valid form token, or it came without browser Origin headers. Staff confirm with the person and click **Accept after review** on the Consent tab (audit-logged).
- **Enforcement:** outgoing calls, texts and emails can't be logged for a do-not-contact person, and outgoing texts can't be logged without current text consent, unless the user gives an override reason (shown on the timeline and audit-logged). Only admins can remove the do-not-contact flag, with a reason. Logging an outgoing call/email/text completes the open "Call back" task.
- **Text/call consent** from the website checkbox is stored with the exact wording shown (version `2026-10-21`), phone number, time, IP, browser, form and page. The consent log is append-only (enforced in the database). **Opt-outs** by any reasonable means (STOP, a phone call, an email…) are recorded with **Record opt-out** on the contact and take effect immediately (FCC rules require honoring them within 10 business days). Marking someone **do not contact** revokes every channel. If a do-not-contact person sends a new website request, it is recorded, the flag is kept, and the dashboard warns you.
- **Time zone:** everything in the CRM is shown and entered in Georgia time (America/New_York, or `CRM_TIMEZONE`), whatever the computer's own time zone. CSV exports also use Eastern time.
- **Turning 65:** someone born on the 1st of a month is treated as turning 65 in the previous month (Medicare's rule).
- **Call logging** includes a "Recorded" checkbox (required for MA/Part D marketing and sales calls, including video meetings).
- **TPMO disclaimer:** the counts (organizations / products) are stored under Settings → Business settings with a preview of the standardized wording. The public pages carry their own copy of the disclaimer; update both each plan year.

### Why there are no Medicare number or SSN fields

The CRM deliberately has **no fields for the Medicare Beneficiary Identifier (MBI) or Social Security number**. Enrollment happens in the carriers' own systems, which already hold those numbers; keeping a second copy here would only add risk if the CRM, a laptop, or a backup were ever exposed. Please don't type them into notes or free-text fields either. Date of birth is optional and only used to work out the turning-65 month.

## Security notes

- Passwords: scrypt with a per-user random salt; minimum 12 characters; no default accounts.
- Sessions: 32-byte random token in an `HttpOnly`, `SameSite=Strict`, `Path=/crm` cookie (`Secure` on HTTPS or with `COOKIE_SECURE=1`). Only a SHA-256 hash of the token is stored. 30-minute idle timeout, 12-hour absolute limit, logout deletes the session, password changes sign out other sessions.
- Login: 5 failed attempts from one address lock that user **from that address** for 15 minutes (doubling on each repeat lock, up to 24 hours), so an attacker can't lock the real user out from everywhere; 50 failures for one user within an hour (from any addresses) locks the account for an hour. Attempts are counted atomically before the password check, so parallel guesses can't slip past. One generic error message; unknown emails take the same time as wrong passwords; per-IP and per-email rate limits. Admins can unlock under Settings → Users.
- CSRF: every state-changing CRM request needs the per-session `X-CSRF-Token` header and a JSON body; cross-site `Origin` / `Sec-Fetch-Site` values are refused.
- Strict Content-Security-Policy on the CRM (no inline scripts or styles, `frame-ancestors 'none'`), plus `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS on HTTPS, `X-Robots-Tag: noindex` and `Cache-Control: no-store` on all CRM API responses. The UI renders all data with `textContent` (never `innerHTML`).
- All SQL is parameterized; every input is validated server-side; body limits are 20 KB (website form) and 100 KB (CRM).
- The website form has a hidden honeypot field and a server-signed form token (`GET /api/form-token`, HMAC with a secret generated in `DATA_DIR/form-secret` on first run). A submission less than 3 seconds after its token was issued gets a fake "thank you" and nothing is stored. A missing/invalid token never loses a real person's request — it is stored as **unverified** and any consent is held for review. Cross-site posts (foreign `Origin` / `Sec-Fetch-Site`) are refused. Rate limits per IP: 5 accepted submissions per 10 minutes and 20 per day; 20 validation failures per 10 minutes.
- SOA evidence (signed time, method, products, linked appointment) can't be changed by agents; admins can correct it with a reason, and the old → new values go on the timeline and in the audit log. An SOA entered after the appointment started is flagged even if its signed time is earlier. Agents can't delete appointments or unlink SOAs; appointment time/type/status changes are written to the timeline, and a cancellation after the start time doesn't hide a missing SOA.
- Timeline: agents can't change the type, direction, time or "recorded" flag of an entry after 24 hours; every edit keeps the previous values (visible to admins), and agents' deletes are soft (admins still see the entry).
- Bulk reads (contact lists/searches, policy, SOA and consent lists, the compliance center) are audit-logged with the row count and the names of the filters used (never the search text). Agents get at most 100 rows per page and can't list active + archived together.
- Append-only is enforced in the database: the audit log, consents, suppressions and website requests reject updates and deletes (except clearing personal data during a permanent delete, and the review fields).
- Files: the process runs with umask 077; the data folder is 0700 and the database files 0600.
- Logs include the signed-in user's ID (not their IP) for `/crm/api` requests. API and CSV responses send `Cross-Origin-Resource-Policy: same-origin`.
- CSV exports are admin-only, audit-logged, and protected against spreadsheet formula injection.
- The audit log is append-only and records sign-ins (and failures), contact views, creates/updates/deletes (field names only, never values or passwords) and exports.
- Static files: no directory traversal, no dotfiles, no symlinks out of `public/`.

## Project layout

```
server/        Node server: app.js (routing), static.js, leads.js (public intake), auth.js, db.js (schema + migrations),
               compliance.js (SOA rule), csv.js, time.js (Georgia time), crm/ (CRM API)
crm/           Admin UI: index.html, app.js, app.css (no build step)
public/        Public website
scripts/       create-user.js, seed-demo.js, backup.js
test/          node:test suites (npm test)
```
