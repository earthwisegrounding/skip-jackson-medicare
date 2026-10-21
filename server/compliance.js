'use strict';
// Scope of Appointment (SOA) timing rule.
//
// Under the CY2027 final rule (CMS-4212-F, applicable to marketing from Oct 1, 2026) the former
// 48-hour waiting period is eliminated (42 CFR 422.2264(c)(3)(i) as revised): the beneficiary's
// agreed scope must be documented PRIOR TO the personal marketing appointment (same day is fine).
// A scope/permission from a beneficiary request is good for 12 months (422.2264(c)(3)(iii)).
// In-person appointments need a written SOA (paper or electronic signature).

const SOA_VALID_MONTHS = 12;

function addMonthsIso(iso, months) {
  const d = new Date(iso);
  const t = new Date(d);
  t.setUTCMonth(t.getUTCMonth() + months);
  return t.toISOString();
}

/** When a scope/permission captured at `iso` stops being usable. */
function permissionExpiresAt(iso) { return addMonthsIso(iso, SOA_VALID_MONTHS); }

/**
 * @param {{starts_at:string, status?:string, type?:string}} appointment
 * @param {{signed_at?:string|null, signature_method?:string}|null} soa
 * @returns {{code:string, level:'ok'|'warn'|'danger'|'muted', label:string}}
 */
function soaCompliance(appointment, soa) {
  if (appointment && appointment.status === 'cancelled') {
    // A cancellation made after the start time must not hide a problem with a meeting that may have happened.
    const cancelledLate = appointment.cancelled_at && Date.parse(appointment.cancelled_at) > Date.parse(appointment.starts_at);
    if (cancelledLate) {
      const underlying = soaCompliance({ ...appointment, status: 'scheduled' }, soa);
      if (underlying.code !== 'ok') return { ...underlying, code: `${underlying.code}`, label: `${underlying.label} (cancelled after the start time)` };
    }
    return { code: 'not_applicable', level: 'muted', label: 'Not applicable (cancelled)' };
  }
  const start = Date.parse(appointment.starts_at);
  const signed = soa && soa.signed_at ? Date.parse(soa.signed_at) : NaN;
  if (!soa || !Number.isFinite(signed) || !Number.isFinite(start)) {
    return { code: 'missing', level: 'danger', label: 'SOA missing' };
  }
  // Entered into the CRM after the meeting started: flagged even if the signed time is earlier (backdating).
  const recorded = soa.created_at ? Date.parse(soa.created_at) : NaN;
  if (signed > start || (Number.isFinite(recorded) && recorded > start)) {
    return { code: 'after_start', level: 'warn', label: 'SOA recorded after appointment start' };
  }
  if (Date.parse(permissionExpiresAt(soa.signed_at)) < start) {
    return { code: 'expired', level: 'danger', label: 'SOA older than 12 months — record a new one' };
  }
  if (appointment.type === 'in-person' && soa.signature_method === 'verbal_recorded') {
    return { code: 'needs_written', level: 'warn', label: 'In-person appointment needs a written SOA' };
  }
  return { code: 'ok', level: 'ok', label: 'OK' };
}

module.exports = { soaCompliance, permissionExpiresAt, SOA_VALID_MONTHS };
