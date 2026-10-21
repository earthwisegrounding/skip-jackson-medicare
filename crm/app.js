/* Skip Jackson CRM — single-page admin app.
   Vanilla JS, no dependencies. All user content is rendered with textContent / DOM nodes
   (never innerHTML), and there are no inline handlers, so it runs under a strict CSP. */
(function () {
  'use strict';

  // ======================================================================
  // DOM helpers
  // ======================================================================
  let uid = 0;
  const nextId = (p) => `${p || 'id'}-${++uid}`;

  function append(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.append(k instanceof Node ? k : String(k));
    }
  }

  /** h('a', {href, class, text, on:{click}}, ...children) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value') value = v;
        else if (['checked', 'selected', 'disabled', 'hidden', 'required', 'multiple', 'open'].includes(k)) el[k] = Boolean(v);
        else if (k === 'style') throw new Error('Inline styles are blocked by CSP');
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    if (value !== undefined) el.value = value;
    // Focus key so focus can return to "the same" control after a re-render.
    if (tag === 'button' && !el.dataset.fk) el.dataset.fk = (props && (props['aria-label'] || props.text)) || el.textContent;
    return el;
  }

  const add = (root, ...kids) => append(root, kids);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ======================================================================
  // Formatting
  // ======================================================================
  const pad = (n) => String(n).padStart(2, '0');
  function fmtPhone(d) {
    if (!d) return '';
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
  }
  // All dates/times are shown and entered in Georgia time (see tz.js), whatever the browser's zone.
  const TZ = window.CrmTz;
  function fmtDate(ymd) {
    if (!ymd) return '';
    if (ymd.length > 10) { const d = new Date(ymd); return Number.isNaN(d.getTime()) ? ymd : TZ.format(d, { month: 'short', day: 'numeric', year: 'numeric' }); }
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDT(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const sameYear = TZ.parts(d).y === TZ.parts(new Date()).y;
    return TZ.format(d, { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtTime(iso) { return TZ.format(new Date(iso), { hour: 'numeric', minute: '2-digit' }); }
  function fmtDay(d) { return TZ.format(d, { weekday: 'long', month: 'long', day: 'numeric' }); }
  function monthLabel(ym) {
    if (!ym) return '';
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
  }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.round(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hrs = Math.round(min / 60);
    if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    const days = Math.round(hrs / 24);
    return `${days} days ago`;
  }
  const toLocalInput = (iso) => TZ.toInput(iso);
  const fromLocalInput = (v) => TZ.fromInput(v);
  const tomorrowAt = (hour) => TZ.dayAt(1, hour).toISOString();
  const todayYmd = () => { const p = TZ.parts(new Date()); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
  const EMAIL_OK = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
  /** mailto link only for well-formed addresses (no header injection). */
  function mailLink(email) {
    if (!email) return null;
    return EMAIL_OK.test(email) ? h('a', { href: `mailto:${email}`, text: email }) : h('span', { text: email });
  }
  const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');
  const money = (n) => (n === null || n === undefined || n === '' ? '' : `$${Number(n).toFixed(2)}`);

  // ======================================================================
  // State, meta lookups
  // ======================================================================
  const state = { user: null, csrf: null, meta: null, contactTab: 'overview', pollTimer: null, lastPath: null };
  const isAdmin = () => state.user && state.user.role === 'admin';
  const opts = (key) => (state.meta ? state.meta[key] : []).map((x) => (Array.isArray(x) ? x : [x, x]));
  function label(key, v) {
    if (v === null || v === undefined || v === '') return '';
    const hit = opts(key).find(([k]) => k === v);
    return hit ? hit[1] : String(v);
  }
  const userOpts = (includeInactive) => (state.meta ? state.meta.users : []).filter((u) => includeInactive || u.active).map((u) => [String(u.id), u.name]);

  // ======================================================================
  // API
  // ======================================================================
  class ApiError extends Error {
    constructor(status, data) {
      super((data && data.message) || ERROR_TEXT[(data && data.error) || ''] || 'Something went wrong. Please try again.');
      this.status = status;
      this.data = data || {};
    }
  }
  const ERROR_TEXT = {
    network: 'Could not reach the server. Check your internet connection and try again.',
    csrf: 'Your security token is out of date. Please reload the page.',
    bad_origin: 'This request was blocked for security reasons. Please reload the page.',
    forbidden: 'You don’t have permission to do that.',
    not_found: 'That record could not be found. It may have been deleted.',
    validation: 'Please fix the highlighted fields.',
    rate_limited: 'Too many attempts. Please wait a few minutes.',
    server_error: 'Something went wrong on the server. Please try again.',
    too_large: 'That is too much text to save at once.',
  };

  async function api(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-CSRF-Token'] = state.csrf || '';
      init.body = JSON.stringify(body || {});
    }
    let res;
    try { res = await fetch(`/crm/api${path}`, init); } catch { throw new ApiError(0, { error: 'network' }); }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/login') {
      sessionLost(data.error === 'session_expired' ? 'expired' : 'signedout');
      throw new ApiError(401, { error: 'unauthenticated', message: 'Please sign in again.' });
    }
    if (!res.ok) throw new ApiError(res.status, data);
    if (path !== '/session') state.lastActivity = Date.now();
    return data;
  }

  function qs(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) if (v !== '' && v !== null && v !== undefined) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  // ======================================================================
  // Toasts
  // ======================================================================
  function toast(msg, kind, action) {
    const box = $('#toasts');
    const t = h('div', { class: `toast${kind === 'error' ? ' error' : ''}` }, h('span', { text: msg }),
      action ? h('button', { type: 'button', class: 'btn small toast-action', text: action.label, on: { click: () => { t.remove(); action.fn(); } } }) : null);
    box.append(t);
    setTimeout(() => t.remove(), kind === 'error' || action ? 9000 : 4500);
  }
  const toastErr = (err) => { if (err && err.status !== 401) toast(err.message || 'Something went wrong.', 'error'); };

  // ======================================================================
  // Forms
  // ======================================================================
  /** Build labelled fields. defs: [{name,label,type,options,required,hint,full,emptyLabel,...}] */
  function buildFields(defs, values) {
    const controls = {};
    const grid = h('div', { class: 'form-grid' });
    for (const d of defs) {
      if (d.legend) {
        const inner = buildFields(d.fields, values);
        Object.assign(controls, inner.controls);
        grid.append(h('fieldset', { class: 'full' }, h('legend', { text: d.legend }), inner.el));
        continue;
      }
      if (d.type === 'html') { grid.append(h('div', { class: 'full' }, d.node)); continue; }
      const id = nextId(`f-${d.name}`);
      const errId = `${id}-err`;
      const hintId = d.hint ? `${id}-hint` : null;
      const v = values ? values[d.name] : undefined;
      const describedBy = [hintId, errId].filter(Boolean).join(' ');
      const err = h('p', { class: 'field-error', id: errId });
      let wrap;
      let input;
      if (d.type === 'checks') {
        const selected = new Set(Array.isArray(v) ? v : []);
        const boxes = d.options.map(([val, lab]) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', name: d.name, value: val, checked: selected.has(val) }), h('span', { text: lab })));
        wrap = h('fieldset', { class: 'field full', 'aria-describedby': describedBy },
          h('legend', { text: d.label + (d.required ? ' (required)' : '') }),
          d.hint ? h('p', { class: 'hint', id: hintId, text: d.hint }) : null,
          h('div', { class: 'checks' }, boxes), err);
        controls[d.name] = { def: d, read: () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value), err, focus: () => boxes[0].querySelector('input').focus(), inputs: boxes.map((b) => b.querySelector('input')) };
        grid.append(wrap);
        continue;
      }
      if (d.type === 'checkbox') {
        input = h('input', { type: 'checkbox', id, name: d.name, checked: Boolean(v), 'aria-describedby': describedBy });
        wrap = h('div', { class: `field${d.full !== false ? ' full' : ''}` },
          h('label', { class: 'check', for: id }, input, h('span', {}, d.label, d.hint ? h('span', { class: 'hint', id: hintId }, h('br'), d.hint) : null)), err);
        controls[d.name] = { def: d, read: () => input.checked, err, focus: () => input.focus(), inputs: [input] };
        grid.append(wrap);
        continue;
      }
      if (d.type === 'contact') {
        // Search-as-you-type contact picker: a search box plus a select of matches.
        const searchId = `${id}-q`;
        const sel = h('select', { id, name: d.name, 'aria-describedby': describedBy }, h('option', { value: '', text: d.emptyLabel || 'No contact (general to-do)' }));
        let timer;
        const q = h('input', { type: 'search', id: searchId, autocomplete: 'off', placeholder: 'Type a name, phone or email', on: { input: (e) => {
          clearTimeout(timer);
          const term = e.target.value.trim();
          timer = setTimeout(async () => {
            if (term.length < 2) return;
            try {
              const r = await api('GET', `/contacts${qs({ q: term, per_page: 10 })}`);
              sel.replaceChildren(h('option', { value: '', text: r.items.length ? `${r.items.length} match${r.items.length === 1 ? '' : 'es'} — choose one` : 'No matches' }),
                ...r.items.map((c) => h('option', { value: String(c.id), text: `${fullName(c)}${c.phone ? ` · ${fmtPhone(c.phone)}` : ''}` })));
              if (r.items.length === 1) sel.value = String(r.items[0].id);
            } catch (err) { toastErr(err); }
          }, 250);
        } } });
        wrap = h('div', { class: 'field full' },
          h('label', { for: searchId, text: `${d.label} — search` }), q,
          h('label', { for: id, class: 'sr-only', text: d.label }), sel,
          d.hint ? h('p', { class: 'hint', id: hintId, text: d.hint }) : null, err);
        controls[d.name] = { def: d, err, focus: () => q.focus(), inputs: [sel], read: () => sel.value };
        grid.append(wrap);
        continue;
      }
      const common = { id, name: d.name, required: d.required, 'aria-describedby': describedBy, autocomplete: d.autocomplete || 'off' };
      if (d.type === 'select') {
        const options = (typeof d.options === 'function' ? d.options() : d.options) || [];
        input = h('select', common,
          d.noEmpty ? null : h('option', { value: '', text: d.emptyLabel || '— Choose —' }),
          options.map(([val, lab]) => h('option', { value: val, text: lab })));
        input.value = v === null || v === undefined ? (d.noEmpty && options[0] ? options[0][0] : '') : String(v);
      } else if (d.type === 'textarea') {
        input = h('textarea', { ...common, rows: d.rows || 4, maxlength: d.maxlength });
        input.value = v || '';
      } else {
        const type = d.type === 'datetime' ? 'datetime-local' : (d.type || 'text');
        input = h('input', { ...common, type, maxlength: d.maxlength, inputmode: d.inputmode, min: d.min, max: d.max, step: d.step, placeholder: d.placeholder });
        input.value = d.type === 'datetime' ? toLocalInput(v) : (v === null || v === undefined ? '' : String(v));
      }
      wrap = h('div', { class: `field${d.full ? ' full' : ''}` },
        h('label', { for: id }, d.label, d.required ? h('span', { class: 'hint', text: ' (required)' }) : null),
        d.hint ? h('p', { class: 'hint', id: hintId, text: d.hint }) : null, input, err);
      const inp = input;
      controls[d.name] = {
        def: d, err, focus: () => inp.focus(), inputs: [inp],
        read: () => (d.type === 'datetime' ? fromLocalInput(inp.value) : (d.type === 'number' && inp.value !== '' ? Number(inp.value) : inp.value.trim())),
      };
      grid.append(wrap);
    }
    return { el: grid, controls };
  }

  function readFields(controls) {
    const out = {};
    for (const [name, c] of Object.entries(controls)) out[name] = c.read();
    return out;
  }

  function showErrors(controls, errors, formErr) {
    let first = null;
    for (const [name, c] of Object.entries(controls)) {
      const msg = errors && errors[name];
      c.err.textContent = msg || '';
      for (const i of c.inputs) { if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); }
      if (msg && !first) first = c;
    }
    const unknown = errors ? Object.keys(errors).filter((k) => !controls[k] && errors[k]) : [];
    if (formErr) formErr.textContent = unknown.length ? unknown.map((k) => errors[k]).join(' ') : (first ? 'Please fix the highlighted fields.' : '');
    if (first) first.focus();
  }

  /** A form element with submit handling + server-side error display. */
  function makeForm({ defs, values, submitLabel = 'Save', busyLabel = 'Saving…', onSubmit, onCancel, cancelLabel = 'Cancel', danger, intro, extraButtons }) {
    const { el, controls } = buildFields(defs, values);
    const formErr = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: `btn ${danger ? 'danger solid' : 'primary'}`, text: submitLabel });
    const form = h('form', { novalidate: true },
      intro || null, formErr, el,
      h('div', { class: 'form-actions' }, extraButtons || null,
        onCancel ? h('button', { type: 'button', class: 'btn', text: cancelLabel, on: { click: onCancel } }) : null, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showErrors(controls, {}, formErr);
      submit.disabled = true;
      const old = submit.textContent;
      submit.textContent = busyLabel;
      try {
        await onSubmit(readFields(controls), { controls, formErr });
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.data.errors) showErrors(controls, err.data.errors, formErr);
          else if (!(err.status === 401 && err.data.error === 'unauthenticated')) formErr.textContent = err.message;
        } else {
          formErr.textContent = err.message || 'Something went wrong.';
        }
      } finally {
        submit.disabled = false;
        submit.textContent = old;
      }
    });
    form.controls = controls;
    form.formErr = formErr;
    return form;
  }

  // ======================================================================
  // Dialogs
  // ======================================================================
  function openDialog(title, content, { onClose } = {}) {
    const returnFocus = document.activeElement;
    const titleId = nextId('dlg');
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': titleId },
      h('div', { class: 'modal-head' }, h('h2', { id: titleId, text: title }),
        h('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Close', text: '✕', on: { click: () => dlg.close() } })),
      h('div', { class: 'modal-body' }, content));
    const fkEl = returnFocus && returnFocus.closest ? returnFocus.closest('[data-fk]') : null;
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (onClose) onClose();
      if (fkEl) state.pendingFocus = fkEl.dataset.fk; // the page may re-render; render() restores focus by key
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('.modal-body input:not([type=hidden]), .modal-body select, .modal-body textarea, .modal-body button');
    if (first) first.focus();
    return dlg;
  }

  /** Open a form in a dialog. onSubmit(values) may throw ApiError; resolves on success. */
  function formDialog({ title, defs, values, submitLabel, onSubmit, danger, intro, success }) {
    let dlg;
    const form = makeForm({
      defs, values, submitLabel, danger, intro,
      onCancel: () => dlg.close(),
      onSubmit: async (vals, ctx) => {
        const r = await onSubmit(vals, ctx);
        if (r === false) return;
        dlg.close();
        if (success) toast(success);
      },
    });
    dlg = openDialog(title, form);
    return dlg;
  }

  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger, requireText, requireLabel }) {
    return new Promise((resolve) => {
      let done = false;
      let dlg;
      const defs = requireText ? [{ name: 'confirm', label: requireLabel || `Type “${requireText}” to confirm`, required: true, full: true }] : [];
      const form = makeForm({
        defs, submitLabel: confirmLabel, danger,
        intro: h('div', {}, (Array.isArray(message) ? message : [message]).map((m) => (typeof m === 'string' ? h('p', { text: m }) : m))),
        onCancel: () => dlg.close(),
        onSubmit: async (v) => {
          if (requireText && v.confirm.replace(/\s+/g, ' ').toLowerCase() !== requireText.replace(/\s+/g, ' ').toLowerCase()) {
            throw new ApiError(400, { errors: { confirm: 'That doesn’t match. Type it exactly as shown.' } });
          }
          done = true;
          dlg.close();
          resolve(requireText ? v.confirm : true);
        },
      });
      dlg = openDialog(title, form, { onClose: () => { if (!done) resolve(false); } });
    });
  }

  // ======================================================================
  // Badges and small components
  // ======================================================================
  function complianceBadge(c) {
    if (!c) return null;
    const cls = { ok: 'ok', info: 'info', warn: 'warn', danger: 'danger' }[c.level] || '';
    const prefix = c.code === 'ok' ? 'SOA: ' : '';
    return h('span', { class: `badge wrap ${cls}`, text: prefix + c.label });
  }
  const stageBadge = (s) => h('span', { class: 'badge stage', text: label('stages', s) });
  const dncBadge = () => h('span', { class: 'badge danger', text: 'Do not contact' });
  const contactLink = (id, name) => h('a', { href: `#/contacts/${id}`, text: name || `Contact #${id}` });
  function phoneLink(p) { return p ? h('a', { href: `tel:+1${p}`, class: 'nowrap', text: fmtPhone(p) }) : null; }
  function empty(text) { return h('p', { class: 'empty', text }); }
  function card(title, ...kids) { return h('section', { class: 'card' }, h('h2', {}, title), ...kids); }
  function pageHead(title, sub, actions) {
    return h('div', { class: 'page-head' },
      h('div', {}, h('h1', { tabindex: '-1', text: title }), sub ? h('p', { class: 'sub', text: sub }) : null),
      actions ? h('div', { class: 'actions' }, actions) : null);
  }
  function td(lab, ...kids) {
    const blank = kids.every((k) => k === null || k === undefined || k === false || k === '' || k === '—');
    return h('td', { 'data-label': lab, class: blank ? 'is-empty' : null }, ...kids);
  }
  const ACTION_LABELS = {
    login: 'Signed in', login_failed: 'Sign-in failed', account_locked: 'Account locked', logout: 'Signed out', view: 'Viewed', list: 'Listed / searched',
    create: 'Created', update: 'Changed', delete: 'Deleted', archive: 'Archived', unarchive: 'Restored from archive', export: 'Exported',
    stage_change: 'Stage changed', dnc_on: 'Marked do-not-contact', dnc_off: 'Removed do-not-contact', dnc_override: 'Contacted despite DNC / no consent',
    dnc_request_reviewed: 'Reviewed DNC request', consent_grant: 'Consent recorded', consent_revoke: 'Opt-out recorded', consent_accept: 'Web consent accepted',
    lead_received: 'Website request received', password_change: 'Changed own password', password_change_failed: 'Password change failed',
    password_reset: 'Password reset', deactivate: 'Deactivated user', reactivate: 'Reactivated user', unlock: 'Unlocked user', complete: 'Completed task', reopen: 'Reopened task',
  };
  const actionLabel = (a) => ACTION_LABELS[a] || a;
  const SOURCE_LABELS = { website: 'Website', manual: 'Added by staff', referral: 'Referral', unknown: 'Unknown' };
  const sourceLabel = (x) => SOURCE_LABELS[x] || (x ? x.charAt(0).toUpperCase() + x.slice(1) : 'Unknown');
  function table(headers, rows, { stack = true } = {}) {
    return h('div', { class: 'table-wrap' }, h('table', { class: stack ? 'stack' : '' },
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col', class: x.num ? 'num' : null, text: x.label || x })))),
      h('tbody', {}, rows)));
  }
  function dueBadge(t) {
    if (t.done_at) return h('span', { class: 'badge ok', text: `Done ${fmtDT(t.done_at)}` });
    if (!t.due_at) return h('span', { class: 'badge', text: 'No due date' });
    const due = new Date(t.due_at);
    const now = new Date();
    const endToday = TZ.endOfDay(now);
    if (due < now) return h('span', { class: 'badge danger', text: `Overdue · ${fmtDT(t.due_at)}` });
    if (due <= endToday) return h('span', { class: 'badge warn', text: `Today · ${fmtTime(t.due_at)}` });
    return h('span', { class: 'badge', text: `Due ${fmtDT(t.due_at)}` });
  }

  // ======================================================================
  // Shared record dialogs
  // ======================================================================
  const reload = () => render({ keepFocus: true });

  function taskDefs(withContact) {
    return [
      { name: 'title', label: 'What needs to be done?', required: true, full: true, maxlength: 200 },
      { name: 'due_at', label: 'Due', type: 'datetime' },
      { name: 'priority', label: 'Priority', type: 'select', options: opts('task_priorities'), noEmpty: true },
      { name: 'assigned_user_id', label: 'Assigned to', type: 'select', options: userOpts(), emptyLabel: 'Me' },
      withContact ? { name: 'contact_id', label: 'Contact (optional)', type: 'contact', hint: 'Leave blank for a general to-do.' } : null,
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
    ].filter(Boolean);
  }
  function addTask(contactId) {
    formDialog({
      title: 'Add task', defs: taskDefs(!contactId), values: { due_at: tomorrowAt(9), priority: 'normal', assigned_user_id: String(state.user.id) },
      submitLabel: 'Add task', success: 'Task added.',
      onSubmit: async (v) => { await api('POST', '/tasks', { ...v, contact_id: contactId || v.contact_id || null }); reload(); },
    });
  }
  function editTask(t) {
    formDialog({
      title: 'Edit task', defs: taskDefs(false), values: { ...t, assigned_user_id: t.assigned_user_id ? String(t.assigned_user_id) : '' },
      success: 'Task updated.', onSubmit: async (v) => { await api('PATCH', `/tasks/${t.id}`, v); reload(); },
    });
  }
  async function deleteTask(t) {
    if (!(await confirmDialog({ title: 'Delete task?', message: `Delete “${t.title}”? This can’t be undone.`, confirmLabel: 'Delete task', danger: true }))) return;
    try { await api('DELETE', `/tasks/${t.id}`); toast('Task deleted.'); reload(); } catch (e) { toastErr(e); }
  }
  async function toggleTask(t, done) {
    state.pendingFocus = `task-${t.id}`;
    try {
      await api('POST', `/tasks/${t.id}/complete`, { done });
      toast(done ? `Task completed: ${t.title}` : 'Task reopened.', null, done ? { label: 'Undo', fn: () => toggleTask(t, false) } : null);
      reload();
    } catch (e) { toastErr(e); }
  }

  function taskList(tasks, { showContact = true, compact = false } = {}) {
    if (!tasks.length) return empty('Nothing here. Nice work.');
    return h('ul', { class: 'list' }, tasks.map((t) => {
      const id = nextId('task');
      return h('li', {},
        h('div', { class: 'main' },
          h('label', { class: 'check', for: id },
            h('input', { type: 'checkbox', id, checked: Boolean(t.done_at), dataset: { fk: `task-${t.id}` }, on: { change: (e) => toggleTask(t, e.target.checked) } }),
            h('span', {}, h('strong', { text: t.title }), t.priority === 'high' ? h('span', { class: 'badge warn', text: 'High' }) : null)),
          h('div', { class: 'meta' }, dueBadge(t), ' ',
            showContact && t.contact_id ? ['· ', contactLink(t.contact_id, fullName(t)), t.phone ? [' · ', phoneLink(t.phone)] : null, t.do_not_contact ? [' ', dncBadge()] : null] : null,
            t.assigned_name ? ` · ${t.assigned_name}` : null),
          t.notes && !compact ? h('p', { class: 'pre small muted', text: t.notes }) : null),
        compact ? null : h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', text: 'Edit', 'aria-label': `Edit task: ${t.title}`, on: { click: () => editTask(t) } }),
          h('button', { type: 'button', class: 'btn small danger', text: 'Delete', 'aria-label': `Delete task: ${t.title}`, on: { click: () => deleteTask(t) } })));
    }));
  }

  function apptDefs(isEdit) {
    return [
      { name: 'starts_at', label: 'Starts', type: 'datetime', required: true },
      { name: 'ends_at', label: 'Ends', type: 'datetime' },
      { name: 'type', label: 'Meeting type', type: 'select', options: opts('meeting_types'), required: true },
      isEdit ? { name: 'status', label: 'Status', type: 'select', options: opts('appointment_status'), noEmpty: true } : null,
      { name: 'location', label: 'Location or link', full: true, maxlength: 200, hint: 'Address for in-person meetings, or “phone” / video link.' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
    ].filter(Boolean);
  }
  const soaReminder = () => h('p', { class: 'notice', text: 'Medicare rule: document the Scope of Appointment before the appointment starts (the same day is fine). In-person meetings need a written SOA (paper or electronic). An SOA is good for 12 months.' });

  /** Show a warning in the form the first time; the user presses Save again to go ahead. */
  function warnOnce(ctx, key, message) {
    if (ctx.formErr.dataset.warned === key) return false;
    ctx.formErr.dataset.warned = key;
    ctx.formErr.textContent = `${message} Press the button again to save anyway.`;
    return true;
  }
  function apptWarnings(v, ctx, soa) {
    if (v.starts_at && Date.parse(v.starts_at) < Date.now() - 5 * 60000 && warnOnce(ctx, `past:${v.starts_at}`, 'This start time is in the past.')) return true;
    if (v.type === 'in-person' && soa && soa.signature_method === 'verbal_recorded' && warnOnce(ctx, 'verbal', 'The SOA for this appointment was verbal. In-person appointments need a written SOA (paper or electronic).')) return true;
    return false;
  }
  function addAppointment(contact) {
    const start = TZ.dayAt(3, 10);
    formDialog({
      title: `Schedule appointment · ${fullName(contact)}`, defs: apptDefs(false), intro: soaReminder(),
      values: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600e3).toISOString(), type: contact.meeting_type || 'phone' },
      submitLabel: 'Schedule', success: 'Appointment scheduled. Remember to record the Scope of Appointment.',
      onSubmit: async (v, ctx) => {
        if (apptWarnings(v, ctx, null)) return false;
        await api('POST', '/appointments', { ...v, contact_id: contact.id });
        reload();
        return undefined;
      },
    });
  }
  function editAppointment(a) {
    formDialog({
      title: 'Edit appointment', defs: apptDefs(true), values: a, success: 'Appointment updated.',
      onSubmit: async (v, ctx) => {
        if (v.starts_at !== a.starts_at && apptWarnings(v, ctx, null)) return false;
        if (apptWarnings({ type: v.type }, ctx, a.soa)) return false;
        await api('PATCH', `/appointments/${a.id}`, v);
        reload();
        return undefined;
      },
    });
  }
  async function setApptStatus(a, status) {
    try { await api('PATCH', `/appointments/${a.id}`, { status }); toast(`Appointment marked ${label('appointment_status', status).toLowerCase()}.`); reload(); } catch (e) { toastErr(e); }
  }
  async function deleteAppointment(a) {
    if (!(await confirmDialog({ title: 'Delete appointment?', message: 'This removes the appointment (a note is kept on the timeline). If it simply didn’t happen, mark it Cancelled or No-show instead.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/appointments/${a.id}`); toast('Appointment deleted.'); reload(); } catch (e) { toastErr(e); }
  }

  function soaDefs(appointments, { evidence = true, reason = false } = {}) {
    return [
      evidence ? { name: 'appointment_id', label: 'For appointment', type: 'select', emptyLabel: 'Not linked to an appointment',
        options: (appointments || []).map((a) => [String(a.id), `${fmtDT(a.starts_at)} · ${label('meeting_types', a.type)} · ${label('appointment_status', a.status)}`]), full: true } : null,
      evidence ? { name: 'products', label: 'Products the beneficiary agreed to discuss', type: 'checks', options: opts('soa_products'), required: true } : null,
      evidence ? { name: 'signed_at', label: 'Signed (date and time, Georgia time)', type: 'datetime', required: true } : null,
      evidence ? { name: 'signature_method', label: 'How it was signed', type: 'select', options: opts('soa_signature_methods'), required: true } : null,
      { name: 'initiated_by', label: 'Meeting requested by', type: 'select', options: opts('soa_initiated_by'), required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
      reason ? { name: 'reason', label: 'Reason for correction', type: 'textarea', full: true, rows: 2, hint: 'Required if you change the signed time, method, products or appointment. Shown on the timeline and kept in the audit log.' } : null,
    ].filter(Boolean);
  }
  function addSoa(contact, appointments, appt) {
    formDialog({
      title: `Record Scope of Appointment · ${fullName(contact)}`, defs: soaDefs(appointments), intro: soaReminder(),
      values: { appointment_id: appt ? String(appt.id) : '', signed_at: new Date().toISOString(), initiated_by: 'beneficiary', products: [] },
      submitLabel: 'Save SOA', success: 'Scope of Appointment saved.',
      onSubmit: async (v, ctx) => {
        const linked = (appointments || []).find((x) => String(x.id) === v.appointment_id);
        if (linked && linked.type === 'in-person' && v.signature_method === 'verbal_recorded'
          && warnOnce(ctx, 'verbal', 'This is an in-person appointment. Medicare requires a written SOA (paper or electronic) for in-person meetings.')) return false;
        if (linked && v.signed_at && Date.parse(v.signed_at) > Date.parse(linked.starts_at)
          && warnOnce(ctx, 'late', 'This SOA is signed after the appointment started. It will be flagged in the Compliance center.')) return false;
        await api('POST', '/soas', { ...v, contact_id: contact.id });
        reload();
        return undefined;
      },
    });
  }
  function editSoa(s, appointments) {
    const admin = isAdmin();
    const summary = h('dl', { class: 'kv' },
      h('dt', { text: 'Signed' }), h('dd', { text: fmtDT(s.signed_at) }),
      h('dt', { text: 'Method' }), h('dd', { text: label('soa_signature_methods', s.signature_method) }),
      h('dt', { text: 'Products' }), h('dd', { text: s.products.map((x) => label('soa_products', x)).join('; ') }));
    formDialog({
      title: 'Edit Scope of Appointment', defs: soaDefs(appointments, { evidence: admin, reason: admin }),
      intro: admin ? h('p', { class: 'notice', text: 'Corrections to the signed time, method, products or linked appointment are recorded on the timeline with the old and new values.' })
        : h('div', {}, h('p', { class: 'notice', text: 'The signature details of a recorded SOA can’t be changed. Ask an admin if something was entered wrong.' }), summary),
      values: { ...s, appointment_id: s.appointment_id ? String(s.appointment_id) : '' }, success: 'SOA updated.',
      onSubmit: async (v) => { await api('PATCH', `/soas/${s.id}`, v); reload(); },
    });
  }
  function deleteSoa(s) {
    formDialog({
      title: 'Delete Scope of Appointment', danger: true, submitLabel: 'Delete SOA',
      intro: h('p', { text: 'SOA records are compliance documents and are normally kept for 10 years. Only delete one that was entered by mistake. Your reason is kept in the audit log.' }),
      defs: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, full: true, rows: 3 }],
      success: 'SOA deleted.', onSubmit: async (v) => { await api('DELETE', `/soas/${s.id}`, v); reload(); },
    });
  }

  function policyDefs() {
    return [
      { name: 'carrier', label: 'Carrier', type: 'select', options: opts('carriers'), required: true },
      { name: 'plan_type', label: 'Plan type', type: 'select', options: opts('plan_types'), required: true },
      { name: 'plan_name', label: 'Plan name', full: true, maxlength: 150 },
      { name: 'plan_id', label: 'Plan ID', placeholder: 'H1234-001', maxlength: 30 },
      { name: 'status', label: 'Status', type: 'select', options: opts('policy_status'), noEmpty: true },
      { name: 'election_period', label: 'Election period', type: 'select', options: opts('election_periods') },
      { name: 'application_submitted_at', label: 'Application submitted', type: 'date' },
      { name: 'application_number', label: 'Application / confirmation #', maxlength: 60 },
      { name: 'effective_date', label: 'Effective date', type: 'date' },
      { name: 'end_date', label: 'End date', type: 'date' },
      { name: 'premium', label: 'Monthly premium ($)', inputmode: 'decimal', maxlength: 12 },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 3 },
    ];
  }
  function addPolicy(contact) {
    formDialog({
      title: `Add policy · ${fullName(contact)}`, defs: policyDefs(), values: { status: 'pending', application_submitted_at: todayYmd() },
      submitLabel: 'Add policy', success: 'Policy added.',
      onSubmit: async (v) => { await api('POST', '/policies', { ...v, contact_id: contact.id }); reload(); },
    });
  }
  function editPolicy(p) {
    formDialog({ title: 'Edit policy', defs: policyDefs(), values: { ...p, premium: p.premium === null ? '' : String(p.premium) }, success: 'Policy updated.',
      onSubmit: async (v) => { await api('PATCH', `/policies/${p.id}`, v); reload(); } });
  }
  async function deletePolicy(p) {
    if (!(await confirmDialog({ title: 'Delete policy?', message: 'Enrollment records are usually kept for 10 years. Prefer changing the status to Cancelled or Terminated. Delete only if this was entered by mistake.', confirmLabel: 'Delete policy', danger: true }))) return;
    try { await api('DELETE', `/policies/${p.id}`); toast('Policy deleted.'); reload(); } catch (e) { toastErr(e); }
  }

  function activityDefs(type) {
    return [
      { name: 'type', label: 'Type', type: 'select', options: opts('manual_activity_types').map(([k]) => [k, label('activity_types', k)]), noEmpty: true },
      { name: 'direction', label: 'Direction', type: 'select', options: [['out', 'Outgoing (I reached out)'], ['in', 'Incoming (they reached out)']], noEmpty: true },
      { name: 'occurred_at', label: 'When', type: 'datetime' },
      { name: 'duration_min', label: 'Length (minutes)', type: 'number', min: 0, max: 1440 },
      type !== 'note' ? { name: 'recorded', label: 'Recorded (required for Medicare Advantage/Part D marketing and sales calls, including video meetings)', type: 'checkbox' } : null,
      { name: 'body', label: type === 'note' ? 'Note' : 'What was discussed', type: 'textarea', full: true, rows: 5, required: type === 'note' },
    ].filter(Boolean);
  }
  const OVERRIDE_DEF = { name: 'override_reason', label: 'Reason for contacting anyway', type: 'textarea', full: true, rows: 2,
    hint: 'Needed for an outgoing call, text or email to someone marked do-not-contact, or a text without text consent (for example: returning their call). Kept in the audit log.' };
  function logActivity(contact, type) {
    const titles = { call: 'Log a call', note: 'Add a note', email: 'Log an email', text: 'Log a text', meeting: 'Log a meeting' };
    let defs = activityDefs(type);
    if (type === 'note') defs = defs.filter((d) => ['type', 'body', 'occurred_at'].includes(d.name));
    else defs = [...defs, OVERRIDE_DEF];
    const dlg = formDialog({
      title: `${titles[type] || 'Log activity'} · ${fullName(contact)}`, defs, values: { type, direction: 'out', occurred_at: new Date().toISOString() },
      submitLabel: 'Save',
      intro: contact.do_not_contact ? h('p', { class: 'form-error', text: 'This person is marked DO NOT CONTACT. Outgoing calls, texts and emails need a reason (below). Incoming contact is fine to log.' }) : null,
      onSubmit: async (v, ctx) => {
        try {
          const r = await api('POST', `/contacts/${contact.id}/activities`, v);
          toast(r.completed_tasks ? 'Saved to the timeline. The open call-back task was marked done.' : 'Saved to the timeline.');
          reload();
        } catch (err) {
          if (err.status === 409 && err.data.needs_override) {
            const c = ctx.controls.override_reason;
            if (c) { c.inputs[0].closest('.field').hidden = false; c.err.textContent = err.data.message; c.inputs[0].setAttribute('aria-invalid', 'true'); c.focus(); }
            ctx.formErr.textContent = err.data.message;
            return false;
          }
          throw err;
        }
        return undefined;
      },
    });
    const ov = dlg.querySelector('[name="override_reason"]');
    if (ov && !contact.do_not_contact) ov.closest('.field').hidden = true;
  }
  function editActivity(a) {
    const locked = a.locked_fields || [];
    formDialog({ title: 'Edit timeline entry', defs: activityDefs(a.type).filter((d) => !locked.includes(d.name)), values: { ...a, recorded: Boolean(a.recorded) }, success: 'Entry updated.',
      intro: locked.length ? h('p', { class: 'notice', text: 'This entry is more than 24 hours old, so only the text can be changed. Every edit is kept in the history.' }) : null,
      onSubmit: async (v) => { await api('PATCH', `/activities/${a.id}`, v); reload(); } });
  }
  async function deleteActivity(a) {
    if (!(await confirmDialog({ title: 'Delete entry?', message: 'Remove this entry from the timeline? Admins can still see deleted entries and their history.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/activities/${a.id}`); toast('Entry deleted.'); reload(); } catch (e) { toastErr(e); }
  }

  function apptItem(a, { showContact, appointments, contact } = {}) {
    return h('li', {},
      h('div', { class: 'main' },
        h('strong', { text: fmtDT(a.starts_at) }), ' ',
        h('span', { class: 'badge', text: label('meeting_types', a.type) }), ' ',
        a.status !== 'scheduled' ? h('span', { class: 'badge', text: label('appointment_status', a.status) }) : null,
        showContact ? h('div', {}, contactLink(a.contact_id, fullName(a)), a.do_not_contact ? [' ', dncBadge()] : null, a.phone ? [' · ', phoneLink(a.phone)] : null) : null,
        a.location ? h('div', { class: 'meta', text: a.location }) : null,
        h('div', {}, complianceBadge(a.compliance)),
        a.notes ? h('p', { class: 'pre small muted', text: a.notes }) : null),
      contact ? h('div', { class: 'actions' },
        !a.soa ? h('button', { type: 'button', class: 'btn small primary', text: 'Record SOA', on: { click: () => addSoa(contact, appointments, a) } }) : null,
        a.status === 'scheduled' ? h('button', { type: 'button', class: 'btn small', text: 'Completed', on: { click: () => setApptStatus(a, 'completed') } }) : null,
        a.status === 'scheduled' ? h('button', { type: 'button', class: 'btn small', text: 'Cancel', on: { click: () => setApptStatus(a, 'cancelled') } }) : null,
        h('button', { type: 'button', class: 'btn small', text: 'Edit', on: { click: () => editAppointment(a) } }),
        isAdmin() ? h('button', { type: 'button', class: 'btn small danger', text: 'Delete', on: { click: () => deleteAppointment(a) } }) : null) : null);
  }

  // ======================================================================
  // Views
  // ======================================================================

  // ---------- Login ----------
  function renderLogin(message) {
    stopPolling();
    state.user = null;
    state.csrf = null;
    document.title = 'Sign in · Skip Jackson CRM';
    const app = $('#app');
    const form = makeForm({
      defs: [
        { name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username', full: true },
        { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password', full: true },
      ],
      submitLabel: 'Sign in', busyLabel: 'Signing in…',
      onSubmit: async (v) => {
        const r = await api('POST', '/login', v);
        state.user = r.user;
        state.csrf = r.csrf;
        state.idleMs = r.idle_timeout_ms;
        await startApp();
        offerUnsaved();
      },
    });
    app.replaceChildren(h('div', { class: 'login-wrap' }, h('main', { class: 'login-card', id: 'main' },
      h('div', { class: 'seal', 'aria-hidden': 'true', text: 'SJ' }),
      h('h1', { text: 'Skip Jackson CRM' }),
      h('p', { class: 'sub', text: 'Medicare client records · authorized staff only' }),
      message ? h('p', { class: 'notice', role: 'status', text: message }) : null,
      form)));
    const email = form.querySelector('input[type=email]');
    if (email) email.focus();
  }

  const idleMinutes = () => Math.round((state.idleMs || 1800000) / 60000);

  /** Keep whatever was typed in open dialogs so it can be offered back after signing in. */
  function stashOpenDialogs() {
    const saved = [];
    for (const dlg of $$('dialog[open]')) {
      const title = (dlg.querySelector('h2') || {}).textContent || 'Form';
      const fields = [];
      for (const el of dlg.querySelectorAll('input, textarea, select')) {
        if (el.type === 'password' || el.type === 'hidden' || el.type === 'checkbox' || el.type === 'search') continue;
        const val = el.tagName === 'SELECT' ? (el.selectedOptions[0] && el.value ? el.selectedOptions[0].textContent : '') : el.value;
        if (!val || !String(val).trim()) continue;
        const lab = el.id ? dlg.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        fields.push({ label: lab ? lab.textContent.replace(' (required)', '') : el.name, value: String(val).slice(0, 5000) });
      }
      if (fields.length) saved.push({ title, fields, route: location.hash });
      dlg.remove();
    }
    if (saved.length) { try { sessionStorage.setItem('crm_unsaved', JSON.stringify(saved)); } catch { /* storage unavailable */ } }
    return saved.length;
  }
  function offerUnsaved() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('crm_unsaved') || 'null'); sessionStorage.removeItem('crm_unsaved'); } catch { saved = null; }
    if (!saved || !saved.length) return;
    const body = h('div', {},
      h('p', { text: 'You had typed this before you were signed out. Nothing was saved yet — copy what you need, then open the form again.' }),
      saved.map((x) => h('section', { class: 'card' }, h('h3', { text: x.title }), x.fields.map((f) => {
        const id = nextId('unsaved');
        return h('div', { class: 'field' }, h('label', { for: id, text: f.label }), h('textarea', { id, readonly: true, rows: Math.min(8, Math.max(2, Math.ceil(f.value.length / 60))), value: f.value }));
      }))),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn primary', text: 'Done', on: { click: () => dlg.close() } })));
    const dlg = openDialog('Unsaved text', body);
  }

  function sessionLost(kind) {
    if (!state.user) return;
    const kept = stashOpenDialogs();
    closeWarning();
    const base = kind === 'expired' ? `You were signed out after ${idleMinutes()} minutes without activity. Please sign in again — you’ll return to the same page.` : 'Please sign in to continue.';
    renderLogin(kept ? `${base} What you were typing has been kept and will be shown after you sign in.` : base);
  }

  // Idle warning ~2 minutes before the server signs us out.
  let warnDlg = null;
  function closeWarning() { if (warnDlg) { const d = warnDlg; warnDlg = null; d.close(); } }
  function checkIdle() {
    if (!state.user || !state.lastActivity) return;
    const left = (state.idleMs || 1800000) - (Date.now() - state.lastActivity);
    if (left <= 0) { closeWarning(); api('GET', '/me').catch(() => {}); return; }
    if (left > 2 * 60000) { closeWarning(); return; }
    if (warnDlg) { const n = warnDlg.querySelector('[data-left]'); if (n) n.textContent = `${Math.max(1, Math.ceil(left / 60000))} minute${left > 60000 ? 's' : ''}`; return; }
    const stay = h('button', { type: 'button', class: 'btn primary', text: 'Stay signed in', on: { click: async () => {
      try { await api('POST', '/keepalive'); closeWarning(); toast('You’re still signed in.'); } catch (e) { toastErr(e); }
    } } });
    warnDlg = openDialog('Still there?', h('div', {},
      h('p', {}, 'For security you’ll be signed out in about ', h('strong', { 'data-left': '', text: `${Math.max(1, Math.ceil(left / 60000))} minutes` }), ' because there’s been no activity.'),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', text: 'Sign out now', on: { click: () => { closeWarning(); logout(); } } }), stay)),
    { onClose: () => { warnDlg = null; } });
    warnDlg.setAttribute('role', 'alertdialog');
    stay.focus();
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.idleTimer) { clearInterval(state.idleTimer); state.idleTimer = null; }
  }

  // ---------- Shell ----------
  const NAV = [
    ['dashboard', 'Dashboard', '◆'], ['contacts', 'Contacts', '☰'], ['pipeline', 'Pipeline', '▤'], ['tasks', 'Tasks', '✓'],
    ['calendar', 'Appointments', '◷'], ['events', 'Events', '✦'], ['compliance', 'Compliance', '⚖'],
    ['reports', 'Reports & exports', '▦', true], ['audit', 'Audit log', '⌕', true], ['settings', 'Settings', '⚙'],
  ];

  function buildShell() {
    const navId = 'sidebar';
    const menuBtn = h('button', { type: 'button', class: 'btn small', 'aria-expanded': 'false', 'aria-controls': navId, text: 'Menu' });
    const sidebar = h('nav', { class: 'sidebar', id: navId, 'aria-label': 'Main' },
      h('a', { class: 'brand', href: '#/dashboard' }, h('span', { class: 'seal', 'aria-hidden': 'true', text: 'SJ' }),
        h('span', { class: 'brand-name' }, 'Skip Jackson', h('small', { text: 'Medicare CRM' }))),
      h('ul', { class: 'nav' }, NAV.filter((n) => !n[3] || isAdmin()).map(([key, text, icon]) => h('li', {},
        h('a', { href: `#/${key}`, dataset: { nav: key } }, h('span', { 'aria-hidden': 'true', text: icon }), text)))),
      h('div', { class: 'userbox' },
        h('strong', { text: state.user.name }), h('span', { class: 'role', text: state.user.role }),
        h('button', { type: 'button', class: 'btn small', text: 'Sign out', on: { click: logout } })));
    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') !== 'true';
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.textContent = open ? 'Close' : 'Menu';
      sidebar.classList.toggle('open', open);
    });
    sidebar.addEventListener('click', (e) => {
      if (e.target.closest('a') && sidebar.classList.contains('open')) { sidebar.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.textContent = 'Menu'; }
    });
    const topbar = h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/dashboard' }, h('span', { class: 'seal', 'aria-hidden': 'true', text: 'SJ' }), h('span', { class: 'brand-name', text: 'Skip Jackson CRM' })),
      menuBtn);
    const main = h('main', { id: 'main', tabindex: '-1' });
    $('#app').replaceChildren(h('div', { class: 'shell' }, topbar, sidebar, main));
  }

  async function logout() {
    try { await api('POST', '/logout'); } catch { /* ignore */ }
    state.user = null;
    renderLogin('You have signed out.');
  }

  // ---------- Router ----------
  const ROUTES = [
    [/^\/?$/, () => viewDashboard],
    [/^\/dashboard$/, () => viewDashboard],
    [/^\/contacts$/, () => viewContacts],
    [/^\/contacts\/(\d+)$/, () => viewContact],
    [/^\/pipeline$/, () => viewPipeline],
    [/^\/tasks$/, () => viewTasks],
    [/^\/calendar$/, () => viewCalendar],
    [/^\/events$/, () => viewEvents],
    [/^\/events\/new$/, () => viewEventEdit],
    [/^\/events\/(\d+)$/, () => viewEventEdit],
    [/^\/events\/(\d+)\/sheet$/, () => viewEventSheet],
    [/^\/events\/(\d+)\/checkin$/, () => viewEventCheckin],
    [/^\/compliance$/, () => viewCompliance],
    [/^\/reports$/, () => viewReports, true],
    [/^\/audit$/, () => viewAudit, true],
    [/^\/settings$/, () => viewSettings],
  ];

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/dashboard';
    const [path, query] = raw.split('?');
    return { path, params: new URLSearchParams(query || '') };
  }

  let renderSeq = 0;
  async function render({ keepFocus = false } = {}) {
    if (!state.user) return;
    const { path, params } = parseHash();
    const main = $('#main');
    if (!main) return;
    let view = null;
    let match = null;
    let denied = false;
    for (const [re, get, adminOnly] of ROUTES) {
      match = re.exec(path);
      if (match) { if (adminOnly && !isAdmin()) { denied = true; break; } view = get(); break; }
    }
    const navKey = path.split('/')[1] || 'dashboard';
    $$('.nav a').forEach((a) => { if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const seq = ++renderSeq;
    const navigated = state.lastPath !== path;
    state.lastPath = path;
    const scrollY = window.scrollY;
    if (!view) {
      main.replaceChildren(pageHead(denied ? 'Only admins can see this page' : 'Page not found'),
        h('p', {}, denied ? 'Your account doesn’t have access to this page. ' : '', 'Go to the ', h('a', { href: '#/dashboard', text: 'dashboard' }), '.'));
      document.title = `${denied ? 'Admins only' : 'Page not found'} · Skip Jackson CRM`;
      const h1x = $('h1', main);
      if (h1x) h1x.focus();
      return;
    }
    if (navigated) main.replaceChildren(h('p', { class: 'loading', text: 'Loading…' }));
    const frag = h('div', {});
    try {
      await view(frag, params, match);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      frag.replaceChildren(pageHead('Something went wrong'), h('p', { class: 'form-error', text: err.message || 'Could not load this page.' }),
        h('button', { type: 'button', class: 'btn', text: 'Try again', on: { click: () => render() } }));
    }
    if (seq !== renderSeq) return;
    main.replaceChildren(...frag.childNodes);
    const h1 = $('h1', main);
    document.title = `${h1 ? h1.textContent : 'CRM'} · Skip Jackson CRM`;
    if (navigated && !keepFocus) {
      window.scrollTo(0, 0);
      if (h1) h1.focus(); else main.focus();
    } else {
      window.scrollTo(0, scrollY);
      const ae = document.activeElement;
      const target = state.pendingFocus ? main.querySelector(`[data-fk="${CSS.escape(state.pendingFocus)}"]`) : null;
      state.pendingFocus = null;
      if (target && !document.querySelector('dialog[open]')) target.focus({ preventScroll: true });
      else if ((!ae || ae === document.body || !document.contains(ae)) && !document.querySelector('dialog[open]')) {
        if (h1) h1.focus({ preventScroll: true }); else main.focus({ preventScroll: true });
      }
    }
  }

  function setParams(params) {
    const { path } = parseHash();
    const s = params.toString();
    history.replaceState(null, '', `#${path}${s ? `?${s}` : ''}`);
  }

  // ---------- Dashboard ----------
  async function viewDashboard(root) {
    const d = await api('GET', '/dashboard');
    const hour = TZ.parts(new Date()).h;
    const kids = [pageHead(`Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${state.user.name.split(' ')[0]}`,
      TZ.format(new Date(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      [h('a', { class: 'btn primary', href: '#/contacts?add=1', text: '+ Add contact' }), h('button', { type: 'button', class: 'btn', text: '+ Add task', on: { click: () => addTask(null) } })])];

    if (d.aep.active) {
      kids.push(h('div', { class: 'banner royal', role: 'note' }, h('div', {},
        h('strong', { text: `Annual Enrollment is open — ${d.aep.days_left === 0 ? 'today is the last day' : `${d.aep.days_left} day${d.aep.days_left === 1 ? '' : 's'} left`} (ends December 7).` }),
        h('span', { text: `${d.annual_review.length} active client${d.annual_review.length === 1 ? '' : 's'} still need an annual review this season.` }))));
    } else if (d.aep.days_until !== null && d.aep.days_until <= 45) {
      kids.push(h('div', { class: 'banner warn', role: 'note' }, h('div', {}, h('strong', { text: `Annual Enrollment starts October 15 (${d.aep.days_until} days).` }), 'Plan ahead for annual reviews.')));
    }

    if (d.dnc_warnings.length) {
      kids.push(h('div', { class: 'banner danger', role: 'alert' }, h('div', {},
        h('strong', { text: 'Do-not-contact people sent a new website request' }),
        h('p', { text: 'They asked to be contacted again, but are still flagged DO NOT CONTACT. Review each one before reaching out.' }),
        h('ul', { class: 'list' }, d.dnc_warnings.map((w) => h('li', {},
          h('div', { class: 'main' }, contactLink(w.id, fullName(w)), h('div', { class: 'meta', text: `Request ${ago(w.requested_at)} · DNC since ${fmtDate(w.dnc_at)}${w.dnc_reason ? ` (${w.dnc_reason})` : ''}` })),
          h('button', { type: 'button', class: 'btn small', text: 'Mark reviewed', on: { click: async () => { try { await api('POST', `/contact-requests/${w.request_id}/review`); toast('Marked reviewed.'); reload(); } catch (e) { toastErr(e); } } } })))))));
    }

    kids.push(h('nav', { 'aria-label': 'Pipeline stages', class: 'stats' }, opts('stages').map(([s, lab]) =>
      h('a', { class: 'stat', href: `#/contacts?stage=${s}` }, h('b', { text: String(d.stage_counts[s] || 0) }), h('span', { text: lab })))));

    const leads = d.new_leads.length ? h('ul', { class: 'list' }, d.new_leads.map((c) => {
      const hrs = (Date.now() - new Date(c.received_at).getTime()) / 3600e3;
      return h('li', {},
        h('div', { class: 'main' }, contactLink(c.id, fullName(c)), c.do_not_contact ? [' ', dncBadge()] : null,
          h('div', { class: 'meta' }, [label('topics', c.topic), c.preferred_contact ? `prefers ${label('preferred_contact', c.preferred_contact).toLowerCase()}` : null, c.preferred_time].filter(Boolean).join(' · ')),
          h('div', { class: 'meta' }, phoneLink(c.phone), c.phone && c.email ? ' · ' : null, mailLink(c.email))),
        h('span', { class: `badge ${hrs > 24 ? 'danger' : hrs > 4 ? 'warn' : 'info'}`, text: `Received ${ago(c.received_at)}` }));
    })) : empty('No new leads waiting. 🎉');

    const appts = d.appointments.length ? h('ul', { class: 'list' }, d.appointments.map((a) => apptItem(a, { showContact: true }))) : empty('No appointments in the next 7 days.');

    const t65 = d.turning_65.length ? h('ul', { class: 'list' }, d.turning_65.map((c) => h('li', {},
      h('div', { class: 'main' }, contactLink(c.id, fullName(c)), h('div', { class: 'meta' }, stageBadge(c.stage), ' ', phoneLink(c.phone))),
      h('span', { class: 'badge info', text: `Turns 65 · ${monthLabel(c.turning_65)}` })))) : empty('No one turning 65 in the next 6 months.');

    const eff = d.effective_soon.length ? h('ul', { class: 'list' }, d.effective_soon.map((p) => h('li', {},
      h('div', { class: 'main' }, contactLink(p.contact_id, fullName(p)), h('div', { class: 'meta', text: `${p.carrier} · ${p.plan_type}${p.plan_name ? ` · ${p.plan_name}` : ''}` })),
      h('span', { class: `badge ${p.status === 'pending' ? 'warn' : 'ok'}`, text: `${label('policy_status', p.status)} · starts ${fmtDate(p.effective_date)}` })))) : empty('No policies starting in the next 30 days.');

    const review = d.annual_review.length ? h('ul', { class: 'list' }, d.annual_review.slice(0, 25).map((c) => h('li', {},
      h('div', { class: 'main' }, contactLink(c.id, fullName(c)), h('div', { class: 'meta', text: c.plans || '' })),
      h('span', { class: 'badge warn', text: c.last_contacted_at ? `Last contact ${fmtDate(c.last_contacted_at)}` : 'No contact logged' })))) : empty('Every active client has been contacted since September 1.');

    kids.push(h('div', { class: 'grid' },
      card(`New leads to contact (${d.new_leads.length})`, leads),
      card(`Tasks due today & overdue (${d.tasks.length})`, taskList(d.tasks, { compact: true }), h('p', {}, h('a', { href: '#/tasks', text: 'All tasks →' }))),
      card(`Appointments · next 7 days (${d.appointments.length})`, appts, h('p', {}, h('a', { href: '#/calendar', text: 'Full agenda →' }))),
      card(`Turning 65 · next 6 months (${d.turning_65.length})`, t65),
      card(`Policies starting · next 30 days (${d.effective_soon.length})`, eff),
      card(`Annual review due (${d.annual_review.length})`, h('p', { class: 'small muted', text: 'Active clients with no call, email, text or meeting logged since September 1.' }), review),
      card(`Upcoming events · next 14 days (${(d.upcoming_events || []).length})`,
        (d.upcoming_events || []).length ? h('ul', { class: 'list' }, d.upcoming_events.map((e) => h('li', {},
          h('div', { class: 'main' }, h('a', { href: `#/events/${e.id}`, text: e.title }),
            h('div', { class: 'meta', text: `${fmtDT(e.starts_at)} · ${e.format === 'online' ? 'Online' : [e.venue_name, e.city].filter(Boolean).join(', ')}` }),
            e.warnings.map((w) => h('p', { class: 'small', }, h('span', { class: 'badge warn wrap', text: w })))),
          h('span', { class: 'badge info', text: `${e.counts.people} coming${e.capacity ? ` of ${e.capacity}` : ''}` })))) : empty('No published events in the next 14 days.'),
        h('p', {}, h('a', { href: '#/events', text: 'All events →' }))),
      card(`Contact permission expired (${d.permission_expired.length})`,
        h('p', { class: 'small muted', text: 'Website requests are good for 12 months. These people asked more than 12 months ago and never enrolled. Don’t reach out about plans unless they contact you again. Nothing is deleted.' }),
        d.permission_expired.length ? h('ul', { class: 'list' }, d.permission_expired.slice(0, 25).map((c) => h('li', {},
          h('div', { class: 'main' }, contactLink(c.id, fullName(c)), h('div', { class: 'meta' }, stageBadge(c.stage))),
          h('span', { class: 'badge', text: `Asked ${fmtDate(c.last_request_at)}` })))) : empty('None.'))));
    add(root, ...kids);
  }

  // ---------- Contacts list ----------
  function contactDefs() {
    return [
      { legend: 'Name and contact', fields: [
        { name: 'first_name', label: 'First name', required: true, maxlength: 60 },
        { name: 'last_name', label: 'Last name', required: true, maxlength: 60 },
        { name: 'preferred_name', label: 'Goes by', maxlength: 60 },
        { name: 'phone', label: 'Phone', type: 'tel', maxlength: 20 },
        { name: 'email', label: 'Email', type: 'email', maxlength: 120 },
        { name: 'preferred_contact', label: 'Prefers', type: 'select', options: opts('preferred_contact') },
        { name: 'preferred_time', label: 'Best time to reach', maxlength: 120, full: true },
      ] },
      { legend: 'Address', fields: [
        { name: 'address', label: 'Street address', full: true, maxlength: 200 },
        { name: 'city', label: 'City', maxlength: 80 },
        { name: 'county', label: 'County', maxlength: 80 },
        { name: 'state', label: 'State', maxlength: 2 },
        { name: 'zip', label: 'ZIP code', inputmode: 'numeric', maxlength: 5 },
      ] },
      { legend: 'Medicare', fields: [
        { name: 'date_of_birth', label: 'Date of birth', type: 'date', hint: 'Optional. Fills in the turning-65 month.' },
        { name: 'turning_65', label: 'Turning 65 (month)', type: 'month' },
        { name: 'medicare_a_effective', label: 'Part A effective', type: 'date' },
        { name: 'medicare_b_effective', label: 'Part B effective', type: 'date' },
        { name: 'current_coverage', label: 'Current coverage', type: 'textarea', full: true, rows: 3, hint: 'Plain description only. Do not store Medicare numbers or Social Security numbers here.' },
      ] },
      { legend: 'Working the lead', fields: [
        { name: 'topic', label: 'Topic', type: 'select', options: opts('topics') },
        { name: 'meeting_type', label: 'Prefers to meet by', type: 'select', options: opts('meeting_types') },
        { name: 'source', label: 'Source', maxlength: 60, hint: 'e.g. website, referral, event' },
        { name: 'assigned_user_id', label: 'Assigned to', type: 'select', options: userOpts(true), emptyLabel: 'Unassigned' },
        { name: 'tags', label: 'Tags', full: true, hint: 'Separate with commas.' },
      ] },
    ];
  }

  function quickAddContact() {
    const defs = [
      { name: 'first_name', label: 'First name', required: true, maxlength: 60 },
      { name: 'last_name', label: 'Last name', required: true, maxlength: 60 },
      { name: 'phone', label: 'Phone', type: 'tel', maxlength: 20 },
      { name: 'email', label: 'Email', type: 'email', maxlength: 120 },
      { name: 'zip', label: 'ZIP code', inputmode: 'numeric', maxlength: 5 },
      { name: 'topic', label: 'Topic', type: 'select', options: opts('topics') },
      { name: 'source', label: 'Source', maxlength: 60, placeholder: 'referral' },
      { name: 'date_of_birth', label: 'Date of birth', type: 'date' },
    ];
    let warnedFor = null; // the phone|email the duplicate warning was shown for
    let dlg = null;
    dlg = formDialog({
      title: 'Add contact', defs, submitLabel: 'Add contact',
      onSubmit: async (v, ctx) => {
        const key = `${(v.phone || '').replace(/\D/g, '')}|${(v.email || '').toLowerCase()}`;
        try {
          // Re-checked on every save: confirming only applies to the exact phone/email that was warned about.
          const r = await api('POST', '/contacts', { ...v, allow_duplicate: warnedFor === key });
          toast('Contact added.');
          location.hash = `#/contacts/${r.id}`;
        } catch (err) {
          if (err.status === 409 && err.data.error === 'duplicate') {
            warnedFor = key;
            ctx.formErr.replaceChildren(`Possible duplicate: ${err.data.name} already has this phone or email. `,
              h('a', { href: `#/contacts/${err.data.contact_id}`, text: 'Open that contact', on: { click: () => dlg.close() } }), ', or press “Add contact” again to create a new one anyway.');
            return false;
          }
          throw err;
        }
        return undefined;
      },
    });
  }

  async function viewContacts(root, params) {
    if (params.get('add') === '1') { params.delete('add'); setParams(params); setTimeout(quickAddContact, 0); }
    const filters = {
      q: params.get('q') || '', stage: params.get('stage') || '', topic: params.get('topic') || '', assigned: params.get('assigned') || '',
      dnc: params.get('dnc') || '', archived: params.get('archived') || '0', t65_from: params.get('t65_from') || '', t65_to: params.get('t65_to') || '',
      sort: params.get('sort') || 'updated', page: params.get('page') || '1',
    };
    const results = h('div', { 'aria-live': 'polite', 'aria-busy': 'false' });
    const sel = (name, lab, options, emptyLabel) => {
      const id = nextId(name);
      return h('div', { class: 'field' }, h('label', { for: id, text: lab }),
        h('select', { id, name, value: filters[name], on: { change: (e) => { filters[name] = e.target.value; filters.page = '1'; load(); } } },
          emptyLabel !== null ? h('option', { value: '', text: emptyLabel }) : null, options.map(([v, l]) => h('option', { value: v, text: l }))));
    };
    const searchId = nextId('q');
    let timer;
    const search = h('input', { type: 'search', id: searchId, value: filters.q, placeholder: 'Name, phone, email or ZIP', autocomplete: 'off',
      on: { input: (e) => { clearTimeout(timer); timer = setTimeout(() => { filters.q = e.target.value; filters.page = '1'; load(); }, 250); } } });
    const monthInput = (name, lab) => {
      const id = nextId(name);
      return h('div', { class: 'field' }, h('label', { for: id, text: lab }), h('input', { type: 'month', id, value: filters[name], on: { change: (e) => { filters[name] = e.target.value; filters.page = '1'; load(); } } }));
    };
    const moreOpen = Boolean(filters.assigned || filters.dnc || filters.archived !== '0' || filters.t65_from || filters.t65_to);
    const toolbar = h('div', { role: 'search', 'aria-label': 'Find contacts' },
      h('div', { class: 'toolbar' },
        h('div', { class: 'field search' }, h('label', { for: searchId, text: 'Search' }), search),
        sel('stage', 'Stage', opts('stages'), 'All stages'),
        sel('topic', 'Topic', opts('topics'), 'All topics'),
        sel('sort', 'Sort by', [['updated', 'Recently updated'], ['created', 'Newest'], ['name', 'Name (A–Z)'], ['stage', 'Stage'], ['turning_65', 'Turning 65 soonest'], ['last_contacted', 'Last contacted']], null)),
      h('details', { class: 'more-filters', open: moreOpen }, h('summary', { text: 'More filters' }),
        h('div', { class: 'toolbar' },
          sel('assigned', 'Assigned', [['me', 'Me'], ['none', 'Unassigned'], ...userOpts(true)], 'Anyone'),
          sel('dnc', 'Do not contact', [['0', 'Exclude DNC'], ['1', 'DNC only']], 'Include DNC'),
          sel('archived', 'Archived', [['0', 'Active only'], ['1', 'Archived only'], ...(isAdmin() ? [['all', 'Active + archived']] : [])], null),
          monthInput('t65_from', 'Turning 65 from'), monthInput('t65_to', 'Turning 65 to'))));

    async function load() {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v && !(k === 'archived' && v === '0') && !(k === 'sort' && v === 'updated') && !(k === 'page' && v === '1')) p.set(k, v);
      setParams(p);
      results.setAttribute('aria-busy', 'true');
      try {
        const r = await api('GET', `/contacts${qs({ ...filters, per_page: 25 })}`);
        const rows = r.items.map((c) => h('tr', {},
          td('Name', contactLink(c.id, fullName(c)), c.preferred_name ? h('span', { class: 'muted', text: ` (${c.preferred_name})` }) : null,
            c.do_not_contact ? [' ', dncBadge()] : null, c.archived_at ? [' ', h('span', { class: 'badge', text: 'Archived' })] : null),
          td('Phone', phoneLink(c.phone)),
          td('Email', mailLink(c.email) || ''),
          td('Stage', stageBadge(c.stage)),
          td('Topic', label('topics', c.topic)),
          td('Turning 65', monthLabel(c.turning_65)),
          td('Last contact', c.last_contacted_at ? fmtDate(c.last_contacted_at) : '—'),
          td('Assigned', c.assigned_name || '—')));
        const from = r.total ? (r.page - 1) * r.per_page + 1 : 0;
        const to = Math.min(r.total, r.page * r.per_page);
        const pages = Math.max(1, Math.ceil(r.total / r.per_page));
        results.replaceChildren(
          r.items.length ? table(['Name', 'Phone', 'Email', 'Stage', 'Topic', 'Turning 65', 'Last contact', 'Assigned'], rows) : empty('No contacts match these filters.'),
          h('div', { class: 'pager' }, h('span', { class: 'muted', text: r.total ? `Showing ${from}–${to} of ${r.total}` : '' }),
            h('div', { class: 'actions' },
              h('button', { type: 'button', class: 'btn small', text: '← Previous', disabled: r.page <= 1, on: { click: () => { filters.page = String(r.page - 1); load(); } } }),
              h('span', { class: 'muted', text: `Page ${r.page} of ${pages}` }),
              h('button', { type: 'button', class: 'btn small', text: 'Next →', disabled: r.page >= pages, on: { click: () => { filters.page = String(r.page + 1); load(); } } }))));
      } catch (err) {
        if (err.status !== 401) results.replaceChildren(h('p', { class: 'form-error', text: err.message }));
      } finally {
        results.setAttribute('aria-busy', 'false');
      }
    }
    add(root, pageHead('Contacts', null, [h('button', { type: 'button', class: 'btn primary', text: '+ Add contact', on: { click: quickAddContact } })]), toolbar, results);
    await load();
  }

  // ---------- Pipeline ----------
  async function moveStage(contactId, stage, focusKey) {
    if (focusKey) state.pendingFocus = focusKey;
    try { await api('POST', `/contacts/${contactId}/stage`, { stage }); toast(`Moved to ${label('stages', stage)}.`); reload(); } catch (e) { toastErr(e); }
  }

  async function viewPipeline(root) {
    const r = await api('GET', '/contacts?per_page=500&sort=updated&archived=0');
    const by = {};
    for (const [s] of opts('stages')) by[s] = [];
    for (const c of r.items) (by[c.stage] || (by[c.stage] = [])).push(c);
    const board = h('div', { class: 'board' }, opts('stages').map(([s, lab]) => {
      const col = h('section', { class: 'column', 'aria-label': `${lab} (${by[s].length})`, dataset: { stage: s } },
        h('h2', {}, h('span', { text: lab }), h('span', { class: 'badge', text: String(by[s].length) })),
        by[s].length ? null : h('p', { class: 'small muted', text: 'No one here.' }),
        by[s].map((c) => {
          const sid = nextId('stage');
          return h('article', { class: 'kcard', draggable: 'true', dataset: { id: String(c.id) },
            on: {
              dragstart: (e) => { e.dataTransfer.setData('text/plain', String(c.id)); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
              dragend: (e) => e.currentTarget.classList.remove('dragging'),
            } },
          contactLink(c.id, fullName(c)), c.do_not_contact ? [' ', dncBadge()] : null,
          h('div', { class: 'meta' }, [fmtPhone(c.phone), label('topics', c.topic), c.assigned_name].filter(Boolean).join(' · ')),
          h('label', { for: sid, text: `Stage for ${fullName(c)}` }),
          h('div', { class: 'move-row' },
            h('select', { id: sid, value: c.stage }, opts('stages').map(([v, l]) => h('option', { value: v, text: l }))),
            h('button', { type: 'button', class: 'btn small', text: 'Move', 'aria-label': `Move ${fullName(c)}`, dataset: { fk: `move-${c.id}` }, on: { click: (e) => {
              const val = e.currentTarget.parentNode.querySelector('select').value;
              if (val === c.stage) { toast(`${fullName(c)} is already in ${label('stages', val)}.`); return; }
              moveStage(c.id, val, `move-${c.id}`);
            } } })));
        }));
      col.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drop-target'); });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop-target'); });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        const c = r.items.find((x) => String(x.id) === id);
        if (c && c.stage !== s) moveStage(c.id, s, `move-${c.id}`);
      });
      return col;
    }));
    add(root, pageHead('Pipeline', 'Drag a card to another column, or choose a stage on the card and press Move.'), board,
      r.total > r.items.length ? h('p', { class: 'muted', text: `Showing the ${r.items.length} most recently updated of ${r.total} contacts.` }) : null);
  }

  // ---------- Contact detail ----------
  const TABS = [['overview', 'Overview'], ['timeline', 'Timeline'], ['tasks', 'Tasks'], ['appointments', 'Appointments & SOA'], ['policies', 'Policies'], ['consent', 'Consent'], ['audit', 'Audit', true]];

  async function viewContact(root, params, match) {
    const id = match[1];
    const d = await api('GET', `/contacts/${id}`);
    const c = d.contact;
    if (state.contactId !== c.id) { state.contactId = c.id; state.contactTab = params.get('tab') || 'overview'; }

    const stageId = nextId('stage');
    const stageSel = h('select', { id: stageId, value: c.stage, on: { change: (e) => moveStage(c.id, e.target.value) } }, opts('stages').map(([v, l]) => h('option', { value: v, text: l })));
    const facts = h('div', { class: 'contact-facts' },
      c.phone ? h('span', {}, '📞 ', phoneLink(c.phone)) : null,
      c.email ? h('span', {}, '✉ ', mailLink(c.email)) : null,
      c.preferred_contact ? h('span', { text: `Prefers ${label('preferred_contact', c.preferred_contact).toLowerCase()}${c.preferred_time ? ` · ${c.preferred_time}` : ''}` }) : null,
      c.turning_65 ? h('span', { text: `Turns 65: ${monthLabel(c.turning_65)}` }) : null,
      c.zip ? h('span', { text: `ZIP ${c.zip}${c.county ? ` · ${c.county} County` : ''}` }) : null,
      h('span', { text: `Assigned: ${c.assigned_name || 'nobody'}` }),
      c.related_contact_id ? h('span', { class: 'badge warn wrap' }, 'Possible household member of ', contactLink(c.related_contact_id, `contact #${c.related_contact_id}`), ' — review') : null,
      d.contact_permission ? h('span', { class: d.contact_permission.expired ? 'badge warn wrap' : 'badge info wrap',
        text: d.contact_permission.expired
          ? `Contact permission from web request expired ${fmtDate(d.contact_permission.expires_at)}`
          : `Contact permission from web request expires ${fmtDate(d.contact_permission.expires_at)}` }) : null);

    const head = h('div', { class: 'contact-head' },
      h('div', {},
        h('p', { class: 'small' }, h('a', { href: '#/contacts', text: '← Contacts' })),
        h('h1', { tabindex: '-1', text: fullName(c) + (c.preferred_name ? ` (“${c.preferred_name}”)` : '') }),
        h('div', { class: 'actions' }, c.do_not_contact ? dncBadge() : null, c.archived_at ? h('span', { class: 'badge', text: `Archived ${fmtDate(c.archived_at)}` }) : null,
          d.consent_state.text.granted ? h('span', { class: 'badge ok', text: 'OK to text' }) : null),
        facts),
      h('div', { class: 'field stage-control' }, h('label', { for: stageId, text: 'Stage' }), stageSel));

    const dncBanner = c.do_not_contact ? h('div', { class: 'banner danger', role: 'note' }, h('div', {},
      h('strong', { text: 'Do not contact' }), h('span', { text: `Flagged ${fmtDate(c.dnc_at)}${c.dnc_reason ? ` — ${c.dnc_reason}` : ''}. All consents are revoked. Don’t call, text or email unless the person reaches out first.` }))) : null;

    const btn = (text, fn, cls) => h('button', { type: 'button', class: `btn ${cls || ''}`, text, on: { click: fn } });
    const quick = h('div', { class: 'quick', role: 'group', 'aria-label': 'Quick actions' },
      btn('📞 Log call', () => logActivity(c, 'call'), 'primary'),
      btn('Add note', () => logActivity(c, 'note')),
      btn('Log email / text', () => logActivity(c, 'email')),
      btn('Add task', () => addTask(c.id)),
      btn('Schedule appointment', () => addAppointment(c)),
      btn('Record SOA', () => addSoa(c, d.appointments)),
      btn('Add policy', () => addPolicy(c)),
      btn('Record opt-out', () => optOutDialog(c), 'danger'));

    // Tabs
    const tabs = TABS.filter((t) => !t[2] || isAdmin());
    if (!tabs.find((t) => t[0] === state.contactTab)) state.contactTab = 'overview';
    const tabIds = Object.fromEntries(tabs.map(([k]) => [k, nextId(`tab-${k}`)]));
    const panel = h('div', { role: 'tabpanel', id: nextId('panel'), tabindex: '0' });
    const tabButtons = tabs.map(([k, lab]) => h('button', {
      type: 'button', role: 'tab', class: 'tab', id: tabIds[k], 'aria-selected': String(k === state.contactTab), tabindex: k === state.contactTab ? '0' : '-1',
      'aria-controls': panel.id, text: lab + (k === 'tasks' ? ` (${d.tasks.filter((t) => !t.done_at).length})` : k === 'appointments' ? ` (${d.appointments.length})` : k === 'policies' ? ` (${d.policies.length})` : ''),
      on: { click: () => selectTab(k, true) },
    }));
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Contact sections' }, tabButtons);
    tablist.addEventListener('keydown', (e) => {
      const i = tabs.findIndex((t) => t[0] === state.contactTab);
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = tabs.length - 1;
      if (n !== null) { e.preventDefault(); selectTab(tabs[n][0], true); }
    });
    function selectTab(k, focus) {
      state.contactTab = k;
      tabButtons.forEach((b, i) => { const on = tabs[i][0] === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
      panel.setAttribute('aria-labelledby', tabIds[k]);
      panel.replaceChildren(); append(panel, renderTab(k));
    }

    function renderTab(k) {
      if (k === 'overview') return tabOverview(c, d);
      if (k === 'timeline') return tabTimeline(d);
      if (k === 'tasks') return [h('div', { class: 'actions' }, btn('+ Add task', () => addTask(c.id), 'primary')), h('div', { class: 'card' }, taskList(d.tasks, { showContact: false }))];
      if (k === 'appointments') return tabAppointments(c, d);
      if (k === 'policies') return tabPolicies(c, d);
      if (k === 'consent') return tabConsent(c, d);
      if (k === 'audit') return tabAudit(c);
      return [];
    }

    // Danger zone
    const more = h('div', { class: 'card' }, h('h2', { text: 'Record status' }),
      h('div', { class: 'actions' },
        c.do_not_contact
          ? (isAdmin() ? btn('Remove do-not-contact', () => dncDialog(c, false)) : null)
          : btn('Mark do not contact', () => dncDialog(c, true), 'danger'),
        c.archived_at ? btn('Restore from archive', () => archive(c, false)) : btn('Archive', () => archive(c, true)),
        isAdmin() ? btn('Delete permanently…', () => deleteContact(c), 'danger') : null),
      h('p', { class: 'small muted', text: 'Medicare-related records are generally kept for 10 years. Archive people you’re no longer working with instead of deleting them.' }));

    add(root, head, dncBanner, quick, tablist, panel, more);
    selectTab(state.contactTab, false);
  }

  function tabOverview(c, d) {
    const values = { ...c, phone: fmtPhone(c.phone), assigned_user_id: c.assigned_user_id ? String(c.assigned_user_id) : '' };
    const form = makeForm({
      defs: contactDefs(), values, submitLabel: 'Save changes',
      onSubmit: async (v) => {
        const r = await api('PATCH', `/contacts/${c.id}`, v);
        toast(r.changed && r.changed.length ? 'Contact saved.' : 'No changes to save.');
        reload();
      },
    });
    const req = d.contact_requests.length ? h('section', { class: 'card' }, h('h2', { text: 'Website requests' }),
      h('p', { class: 'small muted', text: 'Each one is a beneficiary-initiated request to be contacted (kept for Medicare marketing rules).' }),
      h('ul', { class: 'list' }, d.contact_requests.map((r) => h('li', {}, h('div', { class: 'main' },
        h('strong', { text: fmtDT(r.requested_at) }), r.submitted_name ? h('span', { text: ` · submitted as “${r.submitted_name}”` }) : null, ' ',
        r.while_dnc ? h('span', { class: 'badge danger', text: 'Sent while DNC' }) : null,
        r.match_type === 'household' ? h('span', { class: 'badge warn', text: 'Shared phone/email' }) : null,
        r.match_type === 'email' ? h('span', { class: 'badge', text: 'Matched by email' }) : null,
        r.verified === 0 ? h('span', { class: 'badge warn', text: 'Unverified source' }) : null,
        h('div', { class: 'meta', text: [label('topics', r.topic), r.preferred_contact ? `prefers ${label('preferred_contact', r.preferred_contact).toLowerCase()}` : null, r.form_id, r.source_page].filter(Boolean).join(' · ') })))))) : null;
    return [h('section', { class: 'card' }, form), req];
  }

  const FIELD_LABELS = {
    first_name: 'First name', last_name: 'Last name', phone: 'Phone', email: 'Email', zip: 'ZIP', topic: 'Topic', preferred_contact: 'Prefers',
    preferred_time: 'Best time', meeting_type: 'Meeting type', turning_65: 'Turning 65', message: 'Message', consent_texts: 'Consent to calls/texts',
    form_id: 'Form', source_page: 'Page',
  };
  function tabTimeline(d) {
    if (!d.activities.length) return [empty('No activity yet.')];
    return [h('ol', { class: 'timeline', 'aria-label': 'Timeline, newest first' }, d.activities.map((a) => {
      const f = a.meta && a.meta.fields;
      return h('li', { class: `t-${a.type}${a.deleted_at ? ' t-deleted' : ''}` },
        h('div', { class: 't-head' },
          h('strong', { text: label('activity_types', a.type) }),
          a.deleted_at ? h('span', { class: 'badge danger', text: `Deleted ${fmtDT(a.deleted_at)}${a.deleted_by_name ? ` by ${a.deleted_by_name}` : ''}` }) : null,
          a.meta && a.meta.override ? h('span', { class: 'badge warn', text: a.meta.override === 'dnc' ? 'DNC override' : 'No-consent override' }) : null,
          a.direction ? h('span', { class: 'badge', text: a.direction === 'in' ? 'Incoming' : 'Outgoing' }) : null,
          a.type === 'call' ? h('span', { class: `badge ${a.recorded ? 'ok' : 'warn'}`, text: a.recorded ? 'Call recorded' : 'Not recorded' }) : null,
          a.duration_min ? h('span', { class: 'badge', text: `${a.duration_min} min` }) : null,
          h('span', { class: 'muted small', text: `${fmtDT(a.occurred_at)}${a.user_name ? ` · ${a.user_name}` : ''}` })),
        a.body ? h('p', { class: 'pre t-body', text: a.body }) : null,
        f ? h('details', { class: 'fields' }, h('summary', { text: 'Submitted form details' }),
          h('dl', { class: 'kv' }, Object.entries(f).filter(([, v]) => v !== null && v !== '').map(([k, v]) => [
            h('dt', { text: FIELD_LABELS[k] || k }),
            h('dd', { text: k === 'phone' ? fmtPhone(v) : k === 'topic' ? label('topics', v) : String(v) })]),
          a.meta.matched_existing ? [h('dt', { text: 'Matched' }), h('dd', { text: 'Existing contact (no duplicate created)' })] : null)) : null,
        a.meta && a.meta.override_reason ? h('p', { class: 'small', text: `Override reason: ${a.meta.override_reason}` }) : null,
        a.revisions && a.revisions.length ? h('details', { class: 'fields' }, h('summary', { text: `History (${a.revisions.length} change${a.revisions.length === 1 ? '' : 's'})` }),
          h('ul', { class: 'list' }, a.revisions.map((rv) => h('li', {}, h('div', { class: 'main' },
            h('div', { class: 'small muted', text: `${rv.action === 'delete' ? 'Deleted' : 'Edited'} ${fmtDT(rv.at)}${rv.user_name ? ` by ${rv.user_name}` : ''}. Before:` }),
            h('dl', { class: 'kv' }, Object.entries(rv.old_values).map(([k, v]) => [h('dt', { text: k.replace('_', ' ') }), h('dd', { class: 'pre', text: v === null ? '—' : String(v) })]))))))) : null,
        a.editable ? h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', text: 'Edit', on: { click: () => editActivity(a) } }),
          h('button', { type: 'button', class: 'btn small danger', text: 'Delete', on: { click: () => deleteActivity(a) } })) : null);
    }))];
  }

  function tabAppointments(c, d) {
    const soaRows = d.soas.map((s) => h('tr', {},
      td('Signed', fmtDT(s.signed_at)),
      td('Products', s.products.map((p) => label('soa_products', p)).join('; ')),
      td('Method', label('soa_signature_methods', s.signature_method)),
      td('Requested by', label('soa_initiated_by', s.initiated_by)),
      td('Valid until', fmtDate(s.valid_until), new Date(s.valid_until) < new Date() ? [' ', h('span', { class: 'badge', text: 'Expired' })] : null),
      td('Appointment', s.appointment_id ? (() => { const a = d.appointments.find((x) => x.id === s.appointment_id); return a ? fmtDT(a.starts_at) : `#${s.appointment_id}`; })() : '—'),
      td('', h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', text: 'Edit', on: { click: () => editSoa(s, d.appointments) } }),
        isAdmin() ? h('button', { type: 'button', class: 'btn small danger', text: 'Delete…', on: { click: () => deleteSoa(s) } }) : null))));
    return [
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', text: '+ Schedule appointment', on: { click: () => addAppointment(c) } }),
        h('button', { type: 'button', class: 'btn', text: '+ Record SOA', on: { click: () => addSoa(c, d.appointments) } })),
      h('section', { class: 'card' }, h('h2', { text: 'Appointments' }),
        d.appointments.length ? h('ul', { class: 'list' }, d.appointments.map((a) => apptItem(a, { contact: c, appointments: d.appointments }))) : empty('No appointments yet.')),
      h('section', { class: 'card' }, h('h2', { text: 'Scope of Appointment records' }),
        d.soas.length ? table(['Signed', 'Products', 'Method', 'Requested by', 'Valid until', 'Appointment', ''], soaRows) : empty('No SOA on file.')),
    ];
  }

  function tabPolicies(c, d) {
    const rows = d.policies.map((p) => h('tr', {},
      td('Carrier', h('strong', { text: p.carrier })),
      td('Plan', `${p.plan_type}${p.plan_name ? ` · ${p.plan_name}` : ''}${p.plan_id ? ` (${p.plan_id})` : ''}`),
      td('Status', h('span', { class: `badge ${p.status === 'active' ? 'ok' : p.status === 'pending' ? 'warn' : ''}`, text: label('policy_status', p.status) })),
      td('Effective', fmtDate(p.effective_date) || '—', p.end_date ? ` – ${fmtDate(p.end_date)}` : ''),
      td('Period', p.election_period || '—'),
      td('Application', [p.application_submitted_at ? fmtDate(p.application_submitted_at) : null, p.application_number].filter(Boolean).join(' · ') || '—'),
      td('Premium', money(p.premium) || '—'),
      td('', h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', text: 'Edit', on: { click: () => editPolicy(p) } }),
        isAdmin() ? h('button', { type: 'button', class: 'btn small danger', text: 'Delete', on: { click: () => deletePolicy(p) } }) : null))));
    return [
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', text: '+ Add policy', on: { click: () => addPolicy(c) } })),
      h('section', { class: 'card' }, d.policies.length ? table(['Carrier', 'Plan', 'Status', 'Effective', 'Period', 'Application', 'Premium', ''], rows) : empty('No policies yet.')),
    ];
  }

  function consentDialog(c, granted) {
    formDialog({
      title: granted ? 'Record consent' : 'Record revocation (e.g. STOP)', danger: !granted,
      intro: h('p', { class: 'small muted', text: granted
        ? 'Consent history can’t be edited or deleted. Each change is a new entry.'
        : 'Use this when someone replies STOP, asks you not to call, or withdraws email permission. It can’t be undone; record a new consent if they opt back in.' }),
      defs: [
        { name: 'channels', label: 'Channels', type: 'checks', options: opts('consent_channels'), required: true },
        { name: 'source', label: granted ? 'How consent was given' : 'How it was received', type: 'select', options: [['verbal', 'Verbal'], ['written', 'Written'], ['manual', 'Other / staff entry']], required: true },
        granted ? { name: 'consent_text', label: 'What they agreed to', type: 'textarea', full: true, required: true, rows: 3, hint: 'The wording read or shown, or a clear summary.' } : null,
        { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
      ].filter(Boolean),
      values: { channels: granted ? [] : ['text'], source: granted ? 'verbal' : 'manual' },
      submitLabel: granted ? 'Record consent' : 'Record revocation', success: granted ? 'Consent recorded.' : 'Revocation recorded.',
      onSubmit: async (v) => { await api('POST', `/contacts/${c.id}/consents`, { ...v, granted }); reload(); },
    });
  }

  const OPT_OUT_METHODS = [
    ['text_reply', 'Replied STOP (or similar) to a text', 'text_reply'],
    ['verbal', 'Asked on a call, voicemail or in person', 'verbal'],
    ['email_letter', 'Email, letter or website message', 'written'],
    ['other', 'Some other way', 'manual'],
  ];
  function optOutDialog(c) {
    formDialog({
      title: `Record opt-out · ${fullName(c)}`, danger: true, submitLabel: 'Record opt-out', success: 'Opt-out recorded. It takes effect now.',
      intro: h('div', {},
        h('p', { class: 'notice', text: 'People can opt out in any reasonable way — not only by texting STOP. FCC rules require honoring a revocation within 10 business days; recording it here makes it effective immediately.' }),
        h('p', { class: 'small muted', text: 'Opt-outs can’t be edited or deleted. If they opt back in later, record new consent.' })),
      defs: [
        { name: 'channels', label: 'Stop contacting them by', type: 'checks', options: opts('consent_channels'), required: true },
        { name: 'method', label: 'How they asked', type: 'select', options: OPT_OUT_METHODS.map(([k, l]) => [k, l]), required: true },
        { name: 'notes', label: 'Their words or details', type: 'textarea', full: true, rows: 2 },
      ],
      values: { channels: opts('consent_channels').map(([k]) => k), method: 'verbal' },
      onSubmit: async (v) => {
        const m = OPT_OUT_METHODS.find((x) => x[0] === v.method);
        if (!m) throw new ApiError(400, { errors: { method: 'Choose how they asked.' } });
        await api('POST', `/contacts/${c.id}/consents`, {
          channels: v.channels, granted: false, source: m[2], notes: `Opt-out: ${m[1]}.${v.notes ? ` ${v.notes}` : ''}`.slice(0, 1000),
        });
        reload();
      },
    });
  }

  function acceptConsent(c, x) {
    formDialog({
      title: `Accept website ${label('consent_channels', x.channel).toLowerCase()} consent`, submitLabel: 'Accept consent', success: 'Consent accepted and now in effect.',
      intro: h('div', {}, h('p', { class: 'notice', text: `This consent was held for review: ${x.review_reason || 'needs review'}.` }),
        h('p', { text: `Only accept it if you have confirmed that ${fullName(c)} really submitted this request for the number ${fmtPhone(x.phone) || '(none)'} (for example, by speaking with them).` })),
      defs: [{ name: 'note', label: 'How you confirmed it', type: 'textarea', full: true, rows: 2, required: true }],
      onSubmit: async (v) => { await api('POST', `/consents/${x.id}/accept`, v); reload(); },
    });
  }

  function tabConsent(c, d) {
    const tiles = opts('consent_channels').map(([k, lab]) => {
      const s = d.consent_state[k];
      const pending = s.pending && !c.do_not_contact;
      const text = s.granted ? 'Granted' : c.do_not_contact ? 'Revoked (do not contact)' : pending ? 'Pending review' : s.captured_at ? 'Revoked' : 'None on file';
      return h('div', { class: 'consent-tile' }, h('b', { text: lab }),
        h('span', { class: `badge ${s.granted ? 'ok' : pending ? 'warn' : s.captured_at || c.do_not_contact ? 'danger' : ''}`, text }),
        s.captured_at ? h('div', { class: 'small muted', text: `${fmtDate(s.captured_at)} · ${label('consent_sources', s.source)}` }) : null);
    });
    const rows = d.consents.map((x) => h('tr', {},
      td('When', fmtDT(x.captured_at)),
      td('Channel', label('consent_channels', x.channel)),
      td('Change', h('span', { class: `badge ${!x.granted ? 'danger' : x.effective ? 'ok' : 'warn'}`, text: !x.granted ? 'Revoked' : x.effective ? 'Granted' : x.pending_review ? 'Pending review' : 'Held (reviewed)' }),
        x.pending_review ? h('div', {}, h('p', { class: 'small', text: `Held because: ${x.review_reason || 'needs review'}` }),
          h('button', { type: 'button', class: 'btn small primary', text: 'Accept after review', 'aria-label': `Accept ${label('consent_channels', x.channel)} consent from ${fmtDT(x.captured_at)}`, on: { click: () => acceptConsent(c, x) } })) : null),
      td('Source', label('consent_sources', x.source), x.text_version ? h('div', { class: 'small muted', text: `Wording v${x.text_version}` }) : null),
      td('Details', x.consent_text ? h('details', {}, h('summary', { text: 'Wording' }), h('p', { class: 'small pre', text: x.consent_text })) : null,
        x.notes ? h('div', { class: 'small', text: x.notes }) : null,
        h('div', { class: 'small muted', text: [x.phone ? fmtPhone(x.phone) : null, x.ip ? `IP ${x.ip}` : null, x.form_id, x.recorded_by ? `by ${x.recorded_by}` : null].filter(Boolean).join(' · ') }))));
    return [
      h('div', { class: 'consent-grid' }, tiles),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', text: '+ Record consent', disabled: Boolean(c.do_not_contact), on: { click: () => consentDialog(c, true) } }),
        h('button', { type: 'button', class: 'btn danger', text: 'Record opt-out', on: { click: () => optOutDialog(c) } })),
      c.do_not_contact ? h('p', { class: 'small muted', text: isAdmin() ? 'Remove the do-not-contact flag before recording new consent.' : 'This person is marked do-not-contact. Only an admin can remove that flag.' }) : null,
      d.consents.some((x) => x.pending_review) ? h('p', { class: 'notice', text: 'Some website consent is waiting for review and is NOT in effect yet. Don’t text or auto-dial this person until it’s accepted.' }) : null,
      h('section', { class: 'card' }, h('h2', { text: 'Consent history (append-only)' }),
        d.consents.length ? table(['When', 'Channel', 'Change', 'Source', 'Details'], rows) : empty('No consent records.')),
    ];
  }

  function tabAudit(c) {
    const box = h('div', {}, h('p', { class: 'loading', text: 'Loading…' }));
    api('GET', `/audit?entity=contact&entity_id=${c.id}&per_page=100`).then((r) => {
      box.replaceChildren(r.items.length ? table(['When', 'Who', 'Action', 'Details', 'IP'], r.items.map((a) => h('tr', {},
        td('When', fmtDT(a.at)), td('Who', a.user_name || 'Website / system'), td('Action', actionLabel(a.action)), td('Details', a.summary || ''), td('IP', a.ip || '')))) : empty('No audit entries.'));
    }).catch((e) => box.replaceChildren(h('p', { class: 'form-error', text: e.message })));
    return [h('section', { class: 'card' }, h('h2', { text: 'Audit trail for this contact' }), box)];
  }

  function dncDialog(c, on) {
    formDialog({
      title: on ? 'Mark do not contact' : 'Remove do-not-contact', danger: on, submitLabel: on ? 'Mark do not contact' : 'Remove flag',
      intro: h('p', { text: on
        ? 'This revokes consent for every channel (calls, texts, email, automated) and flags the person everywhere in the CRM. Their records are kept.'
        : 'Only remove this if the person has clearly asked to be contacted again. Consents are not restored automatically — record new consent separately.' }),
      defs: [{ name: 'reason', label: on ? 'Reason' : 'Why are you removing it?', full: true, maxlength: 300, required: !on }],
      success: on ? 'Marked do not contact.' : 'Do-not-contact removed.',
      onSubmit: async (v) => {
        if (!on && !v.reason) throw new ApiError(400, { errors: { reason: 'Please note why.' } });
        await api('POST', `/contacts/${c.id}/dnc`, { do_not_contact: on, reason: v.reason });
        reload();
      },
    });
  }
  async function archive(c, on) {
    if (on && !(await confirmDialog({ title: 'Archive contact?', message: `Archive ${fullName(c)}? They’ll be hidden from lists, the pipeline and the dashboard. Nothing is deleted, and you can restore them any time.`, confirmLabel: 'Archive' }))) return;
    try { await api('POST', `/contacts/${c.id}/${on ? 'archive' : 'unarchive'}`); toast(on ? 'Contact archived.' : 'Contact restored.'); reload(); } catch (e) { toastErr(e); }
  }
  async function deleteContact(c) {
    const name = fullName(c);
    const typed = await confirmDialog({
      title: 'Permanently delete contact', danger: true, confirmLabel: 'Delete forever', requireText: name, requireLabel: `Type the full name “${name}” to confirm`,
      message: ['This permanently deletes the contact and ALL of their timeline, tasks, appointments, Scope of Appointment records, policies and consent history. It cannot be undone.',
        'Medicare-related records should generally be kept for 10 years. Archive instead unless you are sure.'],
    });
    if (!typed) return;
    try { await api('DELETE', `/contacts/${c.id}`, { confirm_name: typed }); toast('Contact permanently deleted.'); location.hash = '#/contacts'; } catch (e) { toastErr(e); }
  }

  // ---------- Tasks ----------
  async function viewTasks(root, params) {
    const scope = params.get('scope') || 'mine';
    const status = params.get('status') || 'open';
    const r = await api('GET', `/tasks${qs({ scope, status })}`);
    const now = new Date();
    const endToday = TZ.endOfDay(now);
    const groups = status === 'done' ? [['Completed', r.items]] : [
      ['Overdue', r.items.filter((t) => t.due_at && new Date(t.due_at) < now)],
      ['Today', r.items.filter((t) => t.due_at && new Date(t.due_at) >= now && new Date(t.due_at) <= endToday)],
      ['Upcoming', r.items.filter((t) => t.due_at && new Date(t.due_at) > endToday)],
      ['No due date', r.items.filter((t) => !t.due_at)],
    ];
    const link = (k, v, text) => {
      const p = new URLSearchParams({ scope, status });
      p.set(k, v);
      const cur = (k === 'scope' ? scope : status) === v;
      return h('a', { class: `btn small${cur ? ' primary' : ''}`, href: `#/tasks?${p}`, 'aria-current': cur ? 'true' : null, text });
    };
    add(root, 
      pageHead('Tasks', null, [h('button', { type: 'button', class: 'btn primary', text: '+ Add task', on: { click: () => addTask(null) } })]),
      h('div', { class: 'actions', role: 'group', 'aria-label': 'Filter tasks' }, link('scope', 'mine', 'Mine'), link('scope', 'all', 'Everyone'), h('span', { class: 'muted', text: ' · ' }), link('status', 'open', 'Open'), link('status', 'done', 'Completed')),
      h('div', { class: 'grid' }, groups.filter(([, list]) => list.length || status === 'done').map(([title, list]) => card(`${title} (${list.length})`, taskList(list)))),
      r.items.length ? null : empty(status === 'open' ? 'No open tasks.' : 'No completed tasks yet.'));
  }

  // ---------- Calendar ----------
  async function viewCalendar(root, params) {
    const range = params.get('range') || 'next30';
    const now = new Date();
    const start = TZ.startOfDay(now);
    const ranges = {
      next7: [start, new Date(start.getTime() + 7 * 864e5), 'Next 7 days'],
      next30: [start, new Date(start.getTime() + 31 * 864e5), 'Next 30 days'],
      past30: [new Date(start.getTime() - 30 * 864e5), now, 'Past 30 days'],
      all: [start, null, 'All upcoming'],
    };
    const [from, to] = ranges[range] || ranges.next30;
    const r = await api('GET', `/appointments${qs({ from: from.toISOString(), to: to ? to.toISOString() : '' })}`);
    const days = new Map();
    const items = range === 'past30' ? r.items.slice().reverse() : r.items;
    for (const a of items) {
      const key = TZ.dayKey(a.starts_at);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(a);
    }
    const flagged = r.items.filter((a) => a.compliance && (a.compliance.level === 'danger' || a.compliance.level === 'warn') && a.status === 'scheduled').length;
    add(root, 
      pageHead('Appointments', 'Grouped by day. Each appointment shows its Scope of Appointment status.'),
      h('div', { class: 'actions', role: 'group', 'aria-label': 'Date range' }, Object.entries(ranges).map(([k, v]) =>
        h('a', { class: `btn small${k === range ? ' primary' : ''}`, href: `#/calendar?range=${k}`, 'aria-current': k === range ? 'true' : null, text: v[2] }))),
      flagged ? h('div', { class: 'banner warn', role: 'note' }, h('div', {}, h('strong', { text: `${flagged} upcoming appointment${flagged === 1 ? ' needs' : 's need'} SOA attention.` }), 'Open the contact to record or fix the Scope of Appointment.')) : null,
      days.size ? Array.from(days.entries()).map(([key, list]) => h('section', { class: 'day' },
        h('h2', { text: fmtDay(new Date(list[0].starts_at)) }),
        h('div', { class: 'card' }, h('ul', { class: 'list' }, list.map((a) => apptItem(a, { showContact: true })))))) : empty('No appointments in this range.'));
  }

  // ---------- Compliance ----------
  async function viewCompliance(root) {
    const d = await api('GET', '/compliance');
    const apptRows = d.appointments.map((a) => h('tr', {},
      td('When', fmtDT(a.starts_at)), td('Contact', contactLink(a.contact_id, fullName(a))), td('Type', label('meeting_types', a.type)),
      td('Status', label('appointment_status', a.status)), td('SOA', complianceBadge(a.compliance))));
    const dncRows = d.dnc.map((c) => h('tr', {}, td('Name', contactLink(c.id, fullName(c))), td('Phone', fmtPhone(c.phone)), td('Since', fmtDate(c.dnc_at)), td('Reason', c.dnc_reason || '—')));
    const consentRows = d.consents.map((x) => h('tr', {},
      td('When', fmtDT(x.captured_at)), td('Contact', contactLink(x.contact_id, fullName(x))), td('Channel', label('consent_channels', x.channel)),
      td('Change', h('span', { class: `badge ${x.granted ? 'ok' : 'danger'}`, text: x.granted ? 'Granted' : 'Revoked' })),
      td('Source', label('consent_sources', x.source) + (x.text_version ? ` (v${x.text_version})` : '')), td('By', x.recorded_by || (x.source === 'web_form' ? 'Website' : '—'))));
    const soaRows = d.soas.map((s) => h('tr', {},
      td('Signed', fmtDT(s.signed_at)), td('Contact', contactLink(s.contact_id, fullName(s))), td('Products', s.products.map((p) => label('soa_products', p)).join('; ')),
      td('Method', label('soa_signature_methods', s.signature_method)), td('Valid until', fmtDate(s.valid_until)), td('Recorded by', s.created_by_name || '—')));
    const reqRows = d.contact_requests.map((r) => h('tr', {},
      td('When', fmtDT(r.requested_at)), td('Contact', contactLink(r.contact_id, fullName(r)), r.while_dnc ? [' ', h('span', { class: 'badge danger', text: 'while DNC' })] : null),
      td('Topic', label('topics', r.topic)), td('Prefers', label('preferred_contact', r.preferred_contact)), td('Form', [r.form_id, r.source_page].filter(Boolean).join(' · '))));
    add(root, 
      pageHead('Compliance center', 'Scope of Appointment timing, do-not-contact, consent and permission-to-contact records.'),
      card(`Appointments needing SOA attention (${d.appointments.length})`, h('p', { class: 'small muted', text: 'Upcoming and last 90 days, not cancelled: SOA missing, recorded after the appointment started, older than 12 months, or a verbal SOA for an in-person meeting.' }),
        d.appointments.length ? table(['When', 'Contact', 'Type', 'Status', 'SOA'], apptRows) : empty('All appointments have a compliant SOA. 👍')),
      card(`Do-not-contact list (${d.dnc.length})`, d.dnc.length ? table(['Name', 'Phone', 'Since', 'Reason'], dncRows) : empty('No one is flagged do-not-contact.')),
      card('Website contact requests (permission to contact)', d.contact_requests.length ? table(['When', 'Contact', 'Topic', 'Prefers', 'Form'], reqRows) : empty('None yet.')),
      card('Consent log · latest 100', d.consents.length ? table(['When', 'Contact', 'Channel', 'Change', 'Source', 'By'], consentRows) : empty('No consent records yet.')),
      card('Scope of Appointment records · latest 100', d.soas.length ? table(['Signed', 'Contact', 'Products', 'Method', 'Valid until', 'Recorded by'], soaRows) : empty('No SOA records yet.')),
      d.exports ? card('Recent exports', d.exports.length ? table(['When', 'Who', 'What', 'Rows', 'IP'], d.exports.map((x) => h('tr', {}, td('When', fmtDT(x.at)), td('Who', x.user_name || ''), td('What', x.entity), td('Rows', x.summary || ''), td('IP', x.ip || '')))) : empty('No exports yet.')) : null);
  }

  // ---------- Reports ----------
  async function viewReports(root, params) {
    const year = params.get('year') || String(new Date().getFullYear());
    const r = await api('GET', `/reports?year=${encodeURIComponent(year)}`);
    const max = Math.max(1, ...r.funnel.map((f) => f.count));
    const bar = (lab, n, total) => {
      const fill = h('span', {});
      fill.style.width = `${Math.round((n / total) * 100)}%`; // CSSOM is allowed under CSP
      return h('div', { class: 'bar-row' }, h('span', { text: lab }), h('div', { class: 'bar', 'aria-hidden': 'true' }, fill), h('strong', { class: 'num', text: String(n) }));
    };
    const byType = {};
    for (const p of r.policies_by_carrier) byType[p.plan_type] = (byType[p.plan_type] || 0) + p.n;
    const byCarrier = {};
    for (const p of r.policies_by_carrier) byCarrier[p.carrier] = (byCarrier[p.carrier] || 0) + p.n;
    const dl = (name, text) => h('a', { class: 'btn', href: `/crm/api/export/${name}.csv`, download: `${name}.csv`, text });
    const yearId = nextId('year');
    const years = [];
    for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 5; y--) years.push(String(y));
    add(root, 
      pageHead('Reports & exports'),
      h('div', { class: 'field year-field' }, h('label', { for: yearId, text: 'Year' }),
        h('select', { id: yearId, value: year, on: { change: (e) => { location.hash = `#/reports?year=${e.target.value}`; } } }, years.map((y) => h('option', { value: y, text: y })))),
      card('Download CSV', h('p', { class: 'small muted', text: 'Exports contain personal information. They are logged in the audit log. Store downloaded files securely and delete them when done.' }),
        h('div', { class: 'actions' }, dl('contacts', 'Contacts (CSV)'), dl('policies', 'Policies (CSV)'), dl('consents', 'Consent log (CSV)'))),
      h('div', { class: 'grid' },
        card(`Pipeline conversion · contacts added in ${r.year} (${r.total_contacts})`,
          h('p', { class: 'small muted', text: 'How many reached each stage (at any time).' }),
          r.funnel.map((f) => bar(f.label, f.count, max)),
          h('p', { class: 'small', text: r.total_contacts ? `Enrolled rate: ${Math.round((r.funnel[r.funnel.length - 1].count / r.total_contacts) * 100)}%` : '' })),
        card('Lead sources', Object.keys(r.sources).length ? Object.entries(r.sources).sort((a, b) => b[1] - a[1]).map(([k, n]) => bar(sourceLabel(k), n, Math.max(...Object.values(r.sources)))) : empty('No contacts this year.')),
        card('Active & pending policies by carrier', Object.keys(byCarrier).length ? Object.entries(byCarrier).sort((a, b) => b[1] - a[1]).map(([k, n]) => bar(k, n, Math.max(...Object.values(byCarrier)))) : empty('No policies yet.')),
        card('By plan type', Object.keys(byType).length ? Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, n]) => bar(k, n, Math.max(...Object.values(byType)))) : empty('No policies yet.'))),
      card('Detail: carrier × plan type × status', r.policies_by_carrier.length ? table(['Carrier', 'Plan type', 'Status', { label: 'Count', num: true }],
        r.policies_by_carrier.map((p) => h('tr', {}, td('Carrier', p.carrier), td('Plan type', p.plan_type), td('Status', label('policy_status', p.status)), h('td', { class: 'num', 'data-label': 'Count', text: String(p.n) })))) : empty('No policies yet.'),
      h('p', { class: 'small muted', text: `Applications submitted in ${r.year}: ${r.applications_this_year}` })));
  }

  // ---------- Audit ----------
  async function viewAudit(root, params) {
    const f = { user_id: params.get('user_id') || '', action: params.get('action') || '', entity: params.get('entity') || '', from: params.get('from') || '', to: params.get('to') || '', page: params.get('page') || '1' };
    const r = await api('GET', `/audit${qs({ ...f, per_page: 50 })}`);
    const go = (patch) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...f, page: '1', ...patch })) if (v && !(k === 'page' && v === '1')) p.set(k, v);
      location.hash = `#/audit${p.toString() ? `?${p}` : ''}`;
    };
    const field = (name, lab, input) => { input.id = nextId(name); return h('div', { class: 'field' }, h('label', { for: input.id, text: lab }), input); };
    const mk = (name, options, emptyLabel) => h('select', { value: f[name], on: { change: (e) => go({ [name]: e.target.value }) } }, h('option', { value: '', text: emptyLabel }), options.map(([v, l]) => h('option', { value: v, text: l })));
    const pages = Math.max(1, Math.ceil(r.total / r.per_page));
    const rows = r.items.map((a) => h('tr', {},
      td('When', fmtDT(a.at)), td('Who', a.user_name || (a.action === 'lead_received' ? 'Website' : 'System')), td('Action', actionLabel(a.action)),
      td('Record', a.entity ? (a.entity === 'contact' && a.entity_id ? contactLink(a.entity_id, `contact #${a.entity_id}`) : `${a.entity}${a.entity_id ? ` #${a.entity_id}` : ''}`) : '—'),
      td('Details', a.summary || ''), td('IP', a.ip || '')));
    add(root, 
      pageHead('Audit log', 'Every sign-in, view, change and export. Entries cannot be edited or deleted.'),
      h('div', { class: 'toolbar' },
        field('user', 'User', mk('user_id', userOpts(true), 'Everyone')),
        field('action', 'Action', mk('action', r.actions.map((x) => [x, actionLabel(x)]), 'All actions')),
        field('entity', 'Record type', mk('entity', ['contact', 'user', 'task', 'appointment', 'soa', 'policy', 'activity', 'settings', 'contacts', 'policies', 'consents'].map((x) => [x, x]), 'All')),
        field('from', 'From', h('input', { type: 'date', value: f.from, on: { change: (e) => go({ from: e.target.value }) } })),
        field('to', 'To', h('input', { type: 'date', value: f.to, on: { change: (e) => go({ to: e.target.value }) } }))),
      r.items.length ? table(['When', 'Who', 'Action', 'Record', 'Details', 'IP'], rows) : empty('No entries match.'),
      h('div', { class: 'pager' }, h('span', { class: 'muted', text: `${r.total} entries` }), h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', text: '← Newer', disabled: r.page <= 1, on: { click: () => go({ page: String(r.page - 1) }) } }),
        h('span', { class: 'muted', text: `Page ${r.page} of ${pages}` }),
        h('button', { type: 'button', class: 'btn small', text: 'Older →', disabled: r.page >= pages, on: { click: () => go({ page: String(r.page + 1) }) } }))));
  }

  // ---------- Events ----------
  const EVENT_STATUS_CLASS = { draft: '', published: 'ok', cancelled: 'danger' };
  function eventWhen(e) { return e.starts_at ? `${fmtDT(e.starts_at)}${e.ends_at ? `–${fmtTime(e.ends_at)}` : ''}` : 'No date yet'; }
  function eventWhere(e) { return e.format === 'online' ? 'Online' : [e.venue_name, e.city].filter(Boolean).join(', ') || '—'; }
  function complianceSummary(c) {
    if (!c) return null;
    if (c.blockers) return h('span', { class: 'badge danger', text: `${c.blockers} to fix` });
    if (c.warnings) return h('span', { class: 'badge warn', text: `${c.warnings} warning${c.warnings === 1 ? '' : 's'}` });
    return h('span', { class: 'badge ok', text: 'Checks pass' });
  }

  async function viewEvents(root, params) {
    const tab = params.get('tab') || 'upcoming';
    const r = await api('GET', `/events?tab=${encodeURIComponent(tab)}`);
    const tabs = [['upcoming', 'Upcoming'], ['drafts', 'Drafts'], ['past', 'Past']];
    const rows = r.items.map((e) => h('tr', {},
      td('When', eventWhen(e)),
      td('Event', h('a', { href: `#/events/${e.id}`, text: e.title }), h('div', { class: 'small muted', text: label('event_types', e.event_type) })),
      td('Status', h('span', { class: `badge ${EVENT_STATUS_CLASS[e.status] || ''}`, text: label('event_status', e.status) })),
      td('Where', eventWhere(e)),
      td('RSVPs', `${e.counts.people} people${e.capacity ? ` of ${e.capacity}` : ''}`, e.counts.accommodations ? h('div', { class: 'small muted', text: `${e.counts.accommodations} accommodation request${e.counts.accommodations === 1 ? '' : 's'}` }) : null),
      td('Checks', e.status === 'cancelled' ? '—' : complianceSummary(e.compliance))));
    add(root,
      pageHead('Events', 'Statewide in-person and online events. Published events appear on the public website.',
        [h('a', { class: 'btn primary', href: '#/events/new', text: '+ New event' })]),
      h('div', { class: 'actions', role: 'group', 'aria-label': 'Which events' }, tabs.map(([k, l]) =>
        h('a', { class: `btn small${k === tab ? ' primary' : ''}`, href: `#/events?tab=${k}`, 'aria-current': k === tab ? 'true' : null, text: l }))),
      h('div', { class: 'card events-table' }, r.items.length ? table(['When', 'Event', 'Status', 'Where', 'RSVPs', 'Checks'], rows)
        : empty(tab === 'drafts' ? 'No drafts.' : tab === 'past' ? 'No past events yet.' : 'No upcoming events. Create one with “New event”.')));
  }

  function eventDefs() {
    return [
      { legend: 'About the event', fields: [
        { name: 'title', label: 'Title', required: true, maxlength: 90, full: true, hint: 'Plain and specific, e.g. “Medicare basics with Skip Jackson, licensed insurance agent”.' },
        { name: 'event_type', label: 'Event type', type: 'select', options: opts('event_types'), required: true, full: true,
          hint: 'Educational: general Medicare information only. Information and enrollment: specific plans are discussed and applications may be taken.' },
        { name: 'summary', label: 'Short summary', type: 'textarea', rows: 2, maxlength: 200, full: true, hint: 'Up to 200 characters. Shown on the events list.' },
        { name: 'description', label: 'Full description', type: 'textarea', rows: 7, maxlength: 3000, full: true, hint: 'Plain text. Leave a blank line between paragraphs. The required disclosure is added automatically.' },
      ] },
      { legend: 'When (Georgia time)', fields: [
        { name: 'starts_at', label: 'Starts', type: 'datetime', required: true },
        { name: 'ends_at', label: 'Ends', type: 'datetime', required: true },
      ] },
      { legend: 'Where', fields: [
        { name: 'format', label: 'Format', type: 'select', options: opts('event_formats'), noEmpty: true, full: true },
        { name: 'venue_name', label: 'Venue name', maxlength: 120, full: true },
        { name: 'address', label: 'Street address', maxlength: 200, full: true },
        { name: 'city', label: 'City', maxlength: 80 },
        { name: 'county', label: 'County', maxlength: 80 },
        { name: 'zip', label: 'ZIP code', inputmode: 'numeric', maxlength: 10 },
        { name: 'online_join_info', label: 'Online join link or dial-in', type: 'textarea', rows: 2, full: true, hint: 'Not printed on the listing. Anyone can get it from the event page with “Get the join link” — Medicare rules don’t allow requiring contact details to attend.' },
      ] },
      { legend: 'Attendance', fields: [
        { name: 'rsvp_enabled', label: 'Accept RSVPs on the website', type: 'checkbox' },
        { name: 'capacity', label: 'Seats available', type: 'number', min: 1, max: 5000, hint: 'Optional. Includes guests.' },
        { name: 'accessibility_notes', label: 'Accessibility notes', type: 'textarea', rows: 2, full: true, hint: 'e.g. Wheelchair accessible; parking at front; hearing loop.' },
        { name: 'refreshments', label: 'Refreshments', maxlength: 200, full: true, hint: 'Optional. Light refreshments or snacks only at sales events — no meals.' },
      ] },
      { legend: 'Compliance', fields: [
        { name: 'healthcare_setting', label: 'Is the venue a healthcare setting?', type: 'select', options: opts('healthcare_settings'), noEmpty: true, full: true },
        { name: 'carrier_submitted', label: 'I’ve submitted this event to the insurance companies whose plans I’ll discuss, as their agent policies require', type: 'checkbox' },
        { name: 'carrier_refs', label: 'Carrier submission references', type: 'textarea', rows: 2, full: true, hint: 'Which companies and their confirmation or reference numbers.' },
        { name: 'gifts_ack', label: (state.meta.event_acks || {}).gifts || 'Gift rules confirmed', type: 'checkbox', hint: 'Needed only if the listing mentions gifts, prizes, raffles or drawings.' },
        { name: 'pairing_ack', label: (state.meta.event_acks || {}).pairing || 'Hand-off announcement confirmed', type: 'checkbox', hint: 'Needed only when an educational and a sales event are at the same venue on the same day.' },
      ] },
    ];
  }

  function checklistNode(c) {
    if (!c) return empty('Checking…');
    const icon = (rule) => (rule.ok ? '✓' : rule.level === 'warn' ? '!' : rule.level === 'info' ? 'i' : '✕');
    const rank = (x) => (x.ok ? 3 : x.level === 'block' ? 0 : x.level === 'warn' ? 1 : 2);
    return h('ul', { class: 'rule-list' }, [...c.rules].sort((a, b) => rank(a) - rank(b)).map((rule) => h('li', { class: `rule ${rule.ok ? 'pass' : rule.level}` },
      h('span', { class: 'rule-icon', 'aria-hidden': 'true', text: icon(rule) }),
      h('div', {}, h('span', { class: 'sr-only', text: rule.ok ? 'Passes: ' : rule.level === 'warn' ? 'Warning: ' : 'Must fix: ' }),
        h('strong', { text: rule.label }), rule.message ? h('p', { class: 'small', text: rule.message }) : null))));
  }

  async function viewEventEdit(root, params, match) {
    const id = match && match[1] ? Number(match[1]) : null;
    const e = id ? (await api('GET', `/events/${id}`)).event : null;
    const admin = isAdmin();
    const canEdit = !e || (e.status === 'draft' || (admin && e.status === 'published'));
    const start = TZ.dayAt(14, 10);
    const values = e ? { ...e, rsvp_enabled: Boolean(e.rsvp_enabled), carrier_submitted: Boolean(e.carrier_submitted) }
      : { event_type: 'educational', format: 'in_person', rsvp_enabled: true, healthcare_setting: 'no', starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 90 * 60000).toISOString() };
    const checklistBox = h('div', { 'aria-live': 'polite' }, checklistNode(e ? e.compliance : null));
    const disclosureFor = (t) => (state.meta.event_disclosures || {})[t] || '';
    const discNode = h('p', { class: 'small', text: disclosureFor(values.event_type) });
    const form = makeForm({
      defs: eventDefs(), values, submitLabel: e ? 'Save changes' : 'Save draft',
      onSubmit: async (v) => {
        const body = { ...v, capacity: v.capacity === '' ? '' : v.capacity };
        if (e) {
          const r = await api('PATCH', `/events/${e.id}`, body);
          toast(r.changed && r.changed.length ? 'Event saved.' : 'No changes to save.');
          reload();
        } else {
          const r = await api('POST', '/events', body);
          toast('Draft saved.');
          location.hash = `#/events/${r.id}`;
        }
      },
    });
    let timer;
    async function refreshChecks() {
      const vals = readFields(form.controls);
      discNode.textContent = disclosureFor(vals.event_type);
      try { checklistBox.replaceChildren(checklistNode(await api('POST', '/events/compliance-check', { ...vals, id: e ? e.id : undefined }))); } catch { /* shown on save */ }
    }
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refreshChecks, 500); });
    form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(refreshChecks, 200); });
    if (!e) refreshChecks();
    if (!canEdit) {
      form.querySelectorAll('input, select, textarea, button[type=submit]').forEach((el) => { el.disabled = true; });
    }

    const act = async (path, okMsg, body) => {
      try {
        const r = await api('POST', `/events/${e.id}/${path}`, body || {});
        toast(okMsg);
        reload();
        return r;
      } catch (err) {
        if (err.data && err.data.blockers) { toast(`${err.message} (${err.data.blockers.length} item${err.data.blockers.length === 1 ? '' : 's'})`, 'error'); refreshChecks(); } else toastErr(err);
        return null;
      }
    };
    const buttons = e ? [
      e.starts_at ? h('a', { class: 'btn', href: `/crm/api/events/${e.id}/preview`, target: '_blank', rel: 'noopener', text: 'Preview public page ↗' }) : null,
      e.status === 'published' && e.slug ? h('a', { class: 'btn', href: `/events/${encodeURIComponent(e.slug)}/`, target: '_blank', rel: 'noopener', text: 'View live page ↗' }) : null,
      admin && e.status === 'draft' ? h('button', { type: 'button', class: 'btn primary', text: 'Publish', on: { click: async () => {
        if (!(await confirmDialog({ title: 'Publish this event?', message: 'It will appear on the public Events page and the home page right away.', confirmLabel: 'Publish' }))) return;
        const r = await act('publish', 'Event published.');
        if (r && r.warnings && r.warnings.length) toast(`Published with ${r.warnings.length} warning(s): ${r.warnings.map((w) => w.label).join('; ')}`);
      } } }) : null,
      admin && e.status === 'published' ? h('button', { type: 'button', class: 'btn', text: 'Unpublish', on: { click: async () => {
        if (await confirmDialog({ title: 'Unpublish?', message: 'The event will be removed from the website and become a draft again. Existing RSVPs are kept.', confirmLabel: 'Unpublish' })) act('unpublish', 'Event unpublished.');
      } } }) : null,
      admin && e.status !== 'cancelled' ? h('button', { type: 'button', class: 'btn danger', text: 'Cancel event…', on: { click: () => cancelEvent(e) } }) : null,
      h('button', { type: 'button', class: 'btn', text: 'Duplicate', on: { click: async () => {
        try { const r = await api('POST', `/events/${e.id}/duplicate`); toast('Copy created as a draft. Set the new date.'); location.hash = `#/events/${r.id}`; } catch (err) { toastErr(err); }
      } } }),
      admin && e.status === 'draft' && !e.published_at ? h('button', { type: 'button', class: 'btn danger', text: 'Delete draft', on: { click: async () => {
        if (!(await confirmDialog({ title: 'Delete this draft?', message: 'This can’t be undone.', confirmLabel: 'Delete draft', danger: true }))) return;
        try { await api('DELETE', `/events/${e.id}`); toast('Draft deleted.'); location.hash = '#/events?tab=drafts'; } catch (err) { toastErr(err); }
      } } }) : null,
    ] : null;

    add(root,
      h('p', { class: 'small' }, h('a', { href: '#/events', text: '← Events' })),
      pageHead(e ? e.title : 'New event', e ? `${label('event_types', e.event_type)} · ${eventWhen(e)}` : 'Save as a draft first. An admin publishes it when the checklist passes.'),
      e ? h('div', { class: 'actions' }, h('span', { class: `badge ${EVENT_STATUS_CLASS[e.status] || ''}`, text: label('event_status', e.status) }),
        e.status === 'cancelled' ? h('span', { class: 'badge danger wrap', text: `Cancelled: ${e.cancel_reason || ''}` }) : null, buttons) : null,
      !canEdit ? h('p', { class: 'notice', text: e.status === 'cancelled' ? 'Cancelled events can’t be edited. Use Duplicate to schedule it again.' : 'Only an admin can change a published event.' }) : null,
      h('div', { class: 'event-editor' },
        h('section', { class: 'card' }, form),
        h('aside', { class: 'card event-checks', 'aria-label': 'Compliance checklist' }, h('h2', { text: 'Compliance checklist' }),
          h('p', { class: 'small muted', text: 'Updates as you type. Every “must fix” item has to pass before publishing.' }), checklistBox,
          h('h3', { text: 'Disclosure added to the public page' }), discNode)));
    if (e) add(root, await eventRsvpSection(e));
  }

  function cancelEvent(e) {
    formDialog({
      title: `Cancel “${e.title}”`, danger: true, submitLabel: 'Cancel event',
      intro: h('p', { text: 'The event stays on the website marked “Cancelled” (with your reason) until its date passes. You’ll then see everyone who signed up so you can let them know.' }),
      defs: [{ name: 'reason', label: 'Reason (shown publicly)', type: 'textarea', rows: 2, required: true, full: true, maxlength: 300 }],
      onSubmit: async (v) => {
        const r = await api('POST', `/events/${e.id}/cancel`, v);
        toast('Event cancelled.');
        reload();
        if (r.rsvps && r.rsvps.length) {
          setTimeout(() => openDialog(`Let ${r.rsvps.length} ${r.rsvps.length === 1 ? 'person' : 'people'} know`, h('div', {},
            h('p', { text: 'These people signed up. Call or email each one to tell them the event is cancelled.' }),
            table(['Name', 'Guests', 'Phone', 'Email'], r.rsvps.map((x) => h('tr', {}, td('Name', `${x.first_name} ${x.last_name}`), td('Guests', String(x.guests)),
              td('Phone', phoneLink(x.phone) || '—'), td('Email', mailLink(x.email) || '—')))))), 50);
        }
      },
    });
  }

  async function eventRsvpSection(e) {
    const r = await api('GET', `/events/${e.id}/rsvps`);
    const rows = r.items.map((x) => h('tr', { class: x.status === 'cancelled' ? 'is-cancelled' : null },
      td('Name', h('strong', { text: `${x.first_name} ${x.last_name}` })),
      td('Guests', String(x.guests)),
      td('Phone', phoneLink(x.phone) || ''),
      td('Email', mailLink(x.email) || ''),
      td('Accommodation', x.needs_accommodation || ''),
      td('OK to contact', x.contact_permission ? h('span', { class: 'badge ok', text: 'Yes' }) : h('span', { class: 'badge', text: 'Event only' })),
      td('Contact', x.contact_id ? contactLink(x.contact_id, x.contact_first ? `${x.contact_first} ${x.contact_last}` : `#${x.contact_id}`) : ''),
      td('Status', x.status === 'going' ? h('span', { class: 'badge ok', text: 'Going' }) : h('span', { class: 'badge', text: 'Cancelled' }),
        x.verified === 0 ? h('div', {}, h('span', { class: 'badge warn', text: 'Unverified source' })) : null),
      td('', x.status === 'going' && isAdmin() ? h('button', { type: 'button', class: 'btn small', text: 'Mark cancelled', 'aria-label': `Mark RSVP for ${x.first_name} ${x.last_name} cancelled`, on: { click: async () => {
        if (!(await confirmDialog({ title: 'Mark this RSVP cancelled?', message: `${x.first_name} ${x.last_name} will no longer count toward seats.`, confirmLabel: 'Mark cancelled' }))) return;
        try { await api('POST', `/event-rsvps/${x.id}/cancel`); toast('RSVP marked cancelled.'); reload(); } catch (err) { toastErr(err); }
      } } }) : null)));
    return h('section', { class: 'card' }, h('h2', { text: `RSVPs · ${r.counts.people} ${r.counts.people === 1 ? 'person' : 'people'} coming${e.capacity ? ` of ${e.capacity} seats` : ''}` }),
      h('div', { class: 'actions' },
        h('a', { class: 'btn small', href: `#/events/${e.id}/sheet`, text: 'Printable sign-in sheet (blank)' }),
        h('a', { class: 'btn small', href: `#/events/${e.id}/checkin`, text: 'Staff check-in list' }),
        isAdmin() ? h('a', { class: 'btn small', href: `/crm/api/events/${e.id}/rsvps.csv`, download: '', text: 'Export RSVPs (CSV)' }) : null),
      h('p', { class: 'small muted', text: '“Event only” means the person’s details may be used only for this event (they are removed automatically 90 days after it). “Yes” means they also asked to hear from Skip about Medicare plans (a contact was created or linked). “Unverified source” sign-ups don’t count toward seats.' }),
      r.items.length ? table(['Name', 'Guests', 'Phone', 'Email', 'Accommodation', 'OK to contact', 'Contact', 'Status', ''], rows) : empty('No one has signed up yet.'));
  }

  // Blank sign-in sheet for the event table: no RSVP names pre-printed (others would see them).
  async function viewEventSheet(root, params, match) {
    const id = Number(match[1]);
    const { event: e } = await api('GET', `/events/${id}`);
    add(root,
      h('p', { class: 'small no-print' }, h('a', { href: `#/events/${id}`, text: '← Back to event' })),
      h('div', { class: 'sheet' },
        h('h1', { tabindex: '-1', text: e.title }),
        h('p', { class: 'sheet-meta', text: `${eventWhen(e)} · ${eventWhere(e)}` }),
        h('p', { class: 'sheet-optional', text: 'Signing in is optional.' }),
        h('p', { class: 'sheet-optional', text: 'Contact details are used only for this event unless you check the box.' }),
        h('div', { class: 'table-wrap sheet-wrap' }, h('table', { class: 'sheet-table' },
          h('thead', {}, h('tr', {}, ['Name (optional)', 'Phone or email (optional)', 'OK to contact me about Medicare plans after this event'].map((x) => h('th', { scope: 'col', text: x })))),
          h('tbody', {}, Array.from({ length: 18 }, () => h('tr', {}, h('td', {}), h('td', {}), h('td', { class: 'sheet-box', text: '☐' })))))),
        h('p', { class: 'small sheet-foot', text: `${(state.meta.event_disclosures || {})[e.event_type] || ''}` })),
      h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn primary', text: 'Print', on: { click: () => window.print() } })));
  }

  // Staff-only check-in list with RSVP names. Never put this out on the sign-in table.
  async function viewEventCheckin(root, params, match) {
    const id = Number(match[1]);
    const [{ event: e }, r] = await Promise.all([api('GET', `/events/${id}`), api('GET', `/events/${id}/rsvps`)]);
    const going = r.items.filter((x) => x.status === 'going');
    add(root,
      h('p', { class: 'small no-print' }, h('a', { href: `#/events/${id}`, text: '← Back to event' })),
      h('div', { class: 'sheet' },
        h('p', { class: 'staff-only', text: 'Staff check-in list — do not display' }),
        h('h1', { tabindex: '-1', text: e.title }),
        h('p', { class: 'sheet-meta', text: `${eventWhen(e)} · ${eventWhere(e)} · ${r.counts.people} expected` }),
        h('div', { class: 'table-wrap sheet-wrap' }, h('table', { class: 'sheet-table' },
          h('thead', {}, h('tr', {}, ['Here', 'Name', 'Guests', 'Accommodation'].map((x) => h('th', { scope: 'col', text: x })))),
          h('tbody', {}, going.map((x) => h('tr', {}, h('td', { class: 'sheet-box', text: '☐' }), h('td', { text: `${x.first_name} ${x.last_name}` }),
            h('td', { text: x.guests ? String(x.guests) : '' }), h('td', { text: x.needs_accommodation || '' })))))),
        going.length ? null : empty('No one has signed up yet.')),
      h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn primary', text: 'Print', on: { click: () => window.print() } })));
  }

  // ---------- Settings ----------
  async function viewSettings(root) {
    const pw = makeForm({
      defs: [
        { name: 'current_password', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password', full: true },
        { name: 'new_password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters. A short sentence works well.', full: true },
        { name: 'confirm', label: 'Repeat new password', type: 'password', required: true, autocomplete: 'new-password', full: true },
      ],
      submitLabel: 'Change password',
      onSubmit: async (v, ctx) => {
        if (v.new_password !== v.confirm) throw new ApiError(400, { errors: { confirm: 'The new passwords don’t match.' } });
        await api('POST', '/password', { current_password: v.current_password, new_password: v.new_password });
        Object.values(ctx.controls).forEach((cc) => { cc.inputs[0].value = ''; });
        toast('Password changed. Other devices were signed out.');
      },
    });
    add(root, pageHead('Settings'), h('div', { class: 'grid' }, card('Your password', pw)));
    if (!isAdmin()) return;

    const [users, settings] = await Promise.all([api('GET', '/users'), api('GET', '/settings')]);
    const s = settings.settings;
    const userRows = users.items.map((u) => {
      const locked = Boolean(u.locked);
      return h('tr', {},
        td('Name', h('strong', { text: u.name }), u.id === state.user.id ? h('span', { class: 'muted', text: ' (you)' }) : null),
        td('Email', u.email), td('Role', label('roles', u.role)),
        td('Status', h('span', { class: `badge ${!u.active ? '' : locked ? 'danger' : 'ok'}`, text: !u.active ? 'Inactive' : locked ? 'Locked' : 'Active' })),
        td('Last sign-in', u.last_login ? fmtDT(u.last_login) : 'Never'),
        td('', h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', text: 'Edit', on: { click: () => editUser(u) } }),
          h('button', { type: 'button', class: 'btn small', text: 'Reset password', on: { click: () => resetPassword(u) } }),
          locked ? h('button', { type: 'button', class: 'btn small', text: 'Unlock', on: { click: async () => { try { await api('POST', `/users/${u.id}/unlock`); toast('Unlocked.'); reload(); } catch (e) { toastErr(e); } } } }) : null)));
    });
    const biz = makeForm({
      defs: [
        { name: 'business_name', label: 'Business name', full: true, maxlength: 120 },
        { name: 'number_of_organizations', label: 'Organizations represented', type: 'number', min: 0, max: 999 },
        { name: 'number_of_products', label: 'Products offered in your area', type: 'number', min: 0, max: 9999, hint: 'Used in the required TPMO disclaimer. Update each plan year.' },
        { name: 'business_hours', label: 'Business hours', full: true, maxlength: 200 },
        { name: 'office_phone', label: 'Office phone', type: 'tel', maxlength: 20 },
        { name: 'default_assignee_user_id', label: 'New website leads go to', type: 'select', options: userOpts(), emptyLabel: 'First admin' },
        { name: 'retention_years', label: 'Record retention (years)', type: 'number', min: 1, max: 50 },
      ],
      values: { ...s, office_phone: fmtPhone(s.office_phone) },
      submitLabel: 'Save business settings',
      onSubmit: async (v) => { await api('PUT', '/settings', v); toast('Settings saved.'); await loadMeta(); reload(); },
    });
    const tpmo = `We do not offer every plan available in your area. Currently we represent ${s.number_of_organizations || '[#]'} organizations which offer ${s.number_of_products || '[#]'} products in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.`;
    add(root, 
      card('Users', h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', text: '+ Add user', on: { click: addUser } })),
        h('p', {}), table(['Name', 'Email', 'Role', 'Status', 'Last sign-in', ''], userRows)),
      card('Business settings', biz, h('h3', { text: 'TPMO disclaimer preview' }), h('p', { class: 'small pre', text: tpmo }),
        h('p', { class: 'small muted', text: 'The public website’s disclaimer is part of the site’s pages; update it there too when these numbers change.' })));
  }

  function addUser() {
    formDialog({
      title: 'Add user', submitLabel: 'Create user', success: 'User created. Share the password with them in person or by phone, never by email.',
      defs: [
        { name: 'name', label: 'Name', required: true, maxlength: 80 },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'role', label: 'Role', type: 'select', options: opts('roles'), noEmpty: true, hint: 'Agents can’t export, delete, or manage users and settings.' },
        { name: 'password', label: 'Temporary password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters. Ask them to change it after signing in.' },
      ],
      values: { role: 'agent' },
      onSubmit: async (v) => { await api('POST', '/users', v); await loadMeta(); reload(); },
    });
  }
  function editUser(u) {
    formDialog({
      title: `Edit ${u.name}`, success: 'User updated.',
      defs: [
        { name: 'name', label: 'Name', required: true, maxlength: 80 },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'role', label: 'Role', type: 'select', options: opts('roles'), noEmpty: true },
        { name: 'active', label: 'Account is active', type: 'checkbox', hint: 'Turning this off signs them out everywhere and blocks sign-in. Their records are kept.' },
      ],
      values: { ...u, active: Boolean(u.active) },
      onSubmit: async (v) => { await api('PATCH', `/users/${u.id}`, v); await loadMeta(); reload(); },
    });
  }
  function resetPassword(u) {
    formDialog({
      title: `Reset password · ${u.name}`, submitLabel: 'Set new password', success: 'Password reset. They have been signed out everywhere.',
      defs: [{ name: 'password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters.', full: true }],
      onSubmit: async (v) => { await api('POST', `/users/${u.id}/reset-password`, v); reload(); },
    });
  }

  // ======================================================================
  // Boot
  // ======================================================================
  async function loadMeta() {
    state.meta = await api('GET', '/meta');
    TZ.setZone(state.meta.timezone);
    if (state.meta.idle_timeout_ms) state.idleMs = state.meta.idle_timeout_ms;
  }

  async function startApp() {
    await loadMeta();
    buildShell();
    state.lastPath = null;
    await render();
    stopPolling();
    state.lastActivity = Date.now();
    state.idleTimer = setInterval(checkIdle, 15000);
    state.pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/crm/api/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then((x) => x.json());
        if (!r.authenticated && state.user) sessionLost(r.expired ? 'expired' : 'signedout');
      } catch { /* offline: try again later */ }
    }, 60000);
  }

  document.addEventListener('click', (e) => {
    const skip = e.target.closest('.skip-link');
    if (skip) { e.preventDefault(); const m = $('#main'); if (m) m.focus(); }
  });
  window.addEventListener('hashchange', () => { if (state.user) render(); });

  (async function boot() {
    try {
      const s = await api('GET', '/session');
      if (s.authenticated) {
        state.user = s.user;
        state.csrf = s.csrf;
        state.idleMs = s.idle_timeout_ms;
        await startApp();
        offerUnsaved();
      } else {
        renderLogin(s.expired ? 'Your session ended. Please sign in again.' : null);
      }
    } catch (err) {
      $('#app').replaceChildren(h('main', { id: 'main', class: 'login-wrap' }, h('div', { class: 'login-card' }, h('h1', { text: 'Can’t reach the CRM' }), h('p', { text: err.message }))));
    }
  }());
}());
