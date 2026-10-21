'use strict';
// Shared vocabularies. The admin UI receives these from GET /crm/api/meta,
// so labels live in one place.

const STAGES = [
  ['new', 'New'],
  ['contacted', 'Contacted'],
  ['appointment_set', 'Appointment set'],
  ['comparing_plans', 'Comparing plans'],
  ['application_submitted', 'Application submitted'],
  ['enrolled', 'Enrolled'],
  ['not_now', 'Not now'],
  ['lost', 'Lost / closed'],
];

const TOPICS = [
  ['turning-65', 'Turning 65'],
  ['leaving-employer', 'Retiring / leaving employer coverage'],
  ['review-plan', 'Review current plan'],
  ['helping-parent', 'Helping a parent'],
  ['other', 'Something else'],
];

const PREFERRED_CONTACT = [['phone', 'Phone call'], ['email', 'Email'], ['text', 'Text message']];
const MEETING_TYPES = [['phone', 'Phone'], ['video', 'Video'], ['in-person', 'In person']];

const ACTIVITY_TYPES = [
  ['note', 'Note'], ['call', 'Call'], ['email', 'Email'], ['text', 'Text'], ['meeting', 'Meeting'],
  ['web_form', 'Website form'], ['system', 'System'], ['stage_change', 'Stage change'],
];
// Types a person can create/edit by hand. web_form, system and stage_change are written by the server.
const MANUAL_ACTIVITY_TYPES = ['note', 'call', 'email', 'text', 'meeting'];
const CONTACT_ACTIVITY_TYPES = ['call', 'email', 'text', 'meeting'];

const APPOINTMENT_STATUS = [['scheduled', 'Scheduled'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['no-show', 'No-show']];

const SOA_PRODUCTS = [
  ['medicare_advantage', 'Medicare Advantage (Part C) and cost plans'],
  ['part_d', 'Stand-alone prescription drug plans (Part D)'],
  ['medigap', 'Medicare Supplement (Medigap)'],
  ['dental_vision_hearing', 'Dental / vision / hearing'],
  ['hospital_indemnity', 'Hospital indemnity'],
  ['cancer_heart_stroke', 'Cancer / heart attack / stroke'],
  ['other', 'Other'],
];
const SOA_SIGNATURE_METHODS = [['paper', 'Paper'], ['electronic', 'Electronic'], ['verbal_recorded', 'Verbal (recorded call)']];
const SOA_INITIATED_BY = [['beneficiary', 'Beneficiary'], ['agent', 'Agent']];

const CARRIERS = ['Humana', 'HealthSpring', 'Aetna', 'UnitedHealthcare', 'Wellcare', 'Devoted Health', 'Other'];
const PLAN_TYPES = ['MAPD', 'MA-only', 'PDP', 'Medigap', 'D-SNP', 'C-SNP', 'I-SNP', 'Dental/Vision', 'Hospital indemnity', 'Other'];
const POLICY_STATUS = [['pending', 'Pending'], ['active', 'Active'], ['cancelled', 'Cancelled'], ['terminated', 'Terminated'], ['declined', 'Declined']];
const ELECTION_PERIODS = ['IEP', 'ICEP', 'AEP', 'MA-OEP', 'SEP', 'GI', 'Other'];

const CONSENT_CHANNELS = [['call', 'Calls'], ['text', 'Texts'], ['email', 'Email'], ['automated', 'Automated technology']];
const CONSENT_SOURCES = [['web_form', 'Website form'], ['verbal', 'Verbal'], ['written', 'Written'], ['text_reply', 'Text reply (e.g. STOP)'], ['manual', 'Entered by staff'], ['suppression', 'Opt-out list']];

// Must match the checkbox label on the public site word for word.
const WEB_CONSENT_VERSION = '2026-10-21';
const WEB_CONSENT_TEXT = 'Optional: I agree that Skip Jackson, a licensed insurance agent, may call and text me at the number above about Medicare plans, including calls and texts made with an autodialer or an artificial or prerecorded voice. Consent is not required to buy anything. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See the text message terms and privacy policy.';

const TASK_PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']];
const ROLES = [['admin', 'Admin'], ['agent', 'Agent']];

const keys = (pairs) => pairs.map((p) => (Array.isArray(p) ? p[0] : p));

module.exports = {
  STAGES, TOPICS, PREFERRED_CONTACT, MEETING_TYPES, ACTIVITY_TYPES, MANUAL_ACTIVITY_TYPES, CONTACT_ACTIVITY_TYPES,
  APPOINTMENT_STATUS, SOA_PRODUCTS, SOA_SIGNATURE_METHODS, SOA_INITIATED_BY,
  CARRIERS, PLAN_TYPES, POLICY_STATUS, ELECTION_PERIODS, CONSENT_CHANNELS, CONSENT_SOURCES,
  WEB_CONSENT_VERSION, WEB_CONSENT_TEXT, TASK_PRIORITIES, ROLES, keys,
};
