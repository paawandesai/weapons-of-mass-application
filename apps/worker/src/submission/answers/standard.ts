import type { ProfileDocument } from '@wma/shared';
import type { AnswerResolution, FieldDescriptor, SubmissionContext } from '../types';
import { standardKeyFor, type StandardKey } from './classify';

const PROFILE_FIELD_NAME: Record<StandardKey, string> = {
  full_name: 'identity.full_name',
  first_name: 'identity.full_name',
  last_name: 'identity.full_name',
  email: 'contact.email',
  phone: 'contact.phone',
  location: 'identity.location',
  linkedin: 'contact.linkedin_url',
  github: 'contact.github_url',
  website: 'contact.website_url',
  work_authorization: 'standard_answers.work_authorization',
  visa_sponsorship: 'standard_answers.visa_sponsorship_required',
  no_sponsorship_needed: 'standard_answers.visa_sponsorship_required',
  authorized_without_sponsorship: 'standard_answers.work_authorization',
  start_date: 'standard_answers.start_date',
  notice_period: 'standard_answers.notice_period',
  reasons_for_change: 'standard_answers.reasons_for_change',
  current_company: 'work_history.0.employer',
  current_title: 'work_history.0.title',
  relocation: 'survey.willing_to_relocate',
  consent: 'standard_answers.consent',
};

function currentRole(p: ProfileDocument) {
  return p.work_history.find((w) => w.end_date === null) ?? p.work_history[0] ?? null;
}

/** The raw profile value for a standard key, or null when the profile has none. */
export function profileValue(
  p: ProfileDocument,
  key: StandardKey,
  question = '',
): string | boolean | null {
  const nonEmpty = (s: string | null | undefined) => (s && s.trim() !== '' ? s.trim() : null);
  const name = nonEmpty(p.identity.full_name);
  switch (key) {
    case 'full_name':
      return name;
    case 'first_name':
      return name ? (name.split(/\s+/)[0] ?? null) : null;
    case 'last_name': {
      const parts = name ? name.split(/\s+/) : [];
      return parts.length > 1 ? parts.slice(1).join(' ') : null;
    }
    case 'email':
      return nonEmpty(p.contact.email);
    case 'phone':
      return nonEmpty(p.contact.phone);
    case 'location':
      return nonEmpty(p.identity.location);
    case 'linkedin':
      return nonEmpty(p.contact.linkedin_url);
    case 'github':
      return nonEmpty(p.contact.github_url);
    case 'website':
      return nonEmpty(p.contact.website_url);
    case 'work_authorization':
      return nonEmpty(p.standard_answers.work_authorization);
    case 'visa_sponsorship':
      // Yes means sponsorship IS required.
      return p.standard_answers.visa_sponsorship_required;
    case 'no_sponsorship_needed': {
      const required = p.standard_answers.visa_sponsorship_required;
      return required === null ? null : !required;
    }
    case 'authorized_without_sponsorship': {
      const required = p.standard_answers.visa_sponsorship_required;
      if (required === null) return null;
      if (required) return false;
      return isAuthorizedFor(p.standard_answers.work_authorization, question);
    }
    case 'start_date':
      return nonEmpty(p.standard_answers.start_date);
    case 'notice_period':
      return nonEmpty(p.standard_answers.notice_period);
    case 'reasons_for_change':
      return nonEmpty(p.standard_answers.reasons_for_change);
    case 'current_company':
      return nonEmpty(currentRole(p)?.employer);
    case 'current_title':
      return nonEmpty(currentRole(p)?.title);
    case 'relocation':
      return p.survey.willing_to_relocate;
    case 'consent':
      // Acknowledgements are answered in the affirmative; see docs/design/live-loop-fixes.md rule 10.
      return true;
  }
}

// Places a work-authorization answer or a question can name. A group "covers" the places it lists.
const PLACES: Array<{ id: string; re: RegExp; covers?: string[] }> = [
  {
    id: 'us',
    re: /\bu\.s\.?a?\b|\busa\b|united states|\bin the us\b|\bus (?:citizen|work|based|resident)/,
  },
  {
    id: 'uk',
    re: /\buk\b|\bu\.k\b|united kingdom|great britain|\bengland\b|\bscotland\b|\bwales\b/,
  },
  { id: 'ca', re: /\bcanad\w*/ },
  {
    id: 'eu',
    re: /\beu\b|european union|\beea\b|\beurope\w*/,
    covers: ['de', 'fr', 'es', 'nl', 'ie', 'it', 'pt', 'pl', 'se', 'be', 'at', 'dk', 'fi'],
  },
  { id: 'de', re: /german\w*/ },
  { id: 'fr', re: /\bfrance\b|\bfrench\b/ },
  { id: 'es', re: /\bspain\b|\bspanish\b/ },
  { id: 'nl', re: /netherlands|\bdutch\b/ },
  { id: 'ie', re: /\bireland\b|\birish\b/ },
  { id: 'it', re: /\bitaly\b|\bitalian\b/ },
  { id: 'pt', re: /portugal|portuguese/ },
  { id: 'pl', re: /\bpoland\b|\bpolish\b/ },
  { id: 'se', re: /\bsweden\b|swedish/ },
  { id: 'be', re: /belgi\w*/ },
  { id: 'at', re: /\baustria\b|austrian/ },
  { id: 'dk', re: /denmark|danish/ },
  { id: 'fi', re: /finland|finnish/ },
  { id: 'au', re: /australia\w*/ },
  { id: 'in', re: /\bindia\w*/ },
  { id: 'br', re: /brazil\w*/ },
];

function placesIn(text: string): Set<string> {
  const t = text.toLowerCase();
  return new Set(PLACES.filter((p) => p.re.test(t)).map((p) => p.id));
}

const AUTH_POSITIVE =
  /authori[sz]ed|citizen|permanent resident|green card|settled status|right to work|work permit|eligible|no restrictions|unrestricted/i;
const AUTH_NEGATIVE =
  /\b(?:not|un)\s*(?:authori[sz]ed|eligible|permitted)|unauthori[sz]ed|\brequires?\b|\bneed(?:s)? (?:a )?(?:visa|sponsorship)|\bstudying\b|\bpending\b/i;

/**
 * Whether the profile's work-authorization statement establishes authorization for the place the
 * question names. True only when the statement is positive and covers that place; null when the
 * profile cannot say (an authorization for the EU says nothing about the US).
 */
export function isAuthorizedFor(statement: string | null, question: string): boolean | null {
  const text = statement?.trim();
  if (!text || AUTH_NEGATIVE.test(text) || !AUTH_POSITIVE.test(text)) return null;
  const asked = placesIn(question);
  if (asked.size === 0) return true;
  const held = placesIn(text);
  if (held.size === 0) return null;
  for (const id of asked) {
    const covered = [...held].some(
      (h) => h === id || (PLACES.find((p) => p.id === h)?.covers ?? []).includes(id),
    );
    if (!covered) return null;
  }
  return true;
}

const YES = /^(?:yes|y|true)\b/i;
const NO = /^(?:no|n|false)\b/i;

/** The field is answered Yes/No: a checkbox, or options that include a Yes and a No. */
function isYesNoField(f: FieldDescriptor): boolean {
  if (f.type === 'checkbox' && !f.options?.length) return true;
  if (!f.options?.length) return f.type === 'radio' || f.type === 'select';
  return f.options.some((o) => YES.test(o.trim())) && f.options.some((o) => NO.test(o.trim()));
}

/**
 * A boolean fact as the field wants it, by meaning: a lone checkbox takes the boolean, options take
 * the Yes-like or No-like entry, a text box takes "Yes"/"No". Null when the field's options
 * cannot express the fact (nothing is typed in that case, never free text).
 */
function yesNo(value: boolean, f: FieldDescriptor): string | boolean | null {
  if (f.type === 'checkbox' && !f.options?.length) return value;
  if (!f.options?.length) return value ? 'Yes' : 'No';
  return f.options.find((o) => (value ? YES : NO).test(o.trim())) ?? null;
}

/** The option equal to `text` ignoring case, when the field offers options. */
function matchOption(text: string, f: FieldDescriptor): string | null {
  const hit = f.options?.find((o) => o.trim().toLowerCase() === text.trim().toLowerCase());
  return hit ?? null;
}

type Resolved = { value: string | boolean } | { unexpressible: true } | null;

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const DURATION =
  /\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*(day|week|month)s?\b/;

function addDuration(from: Date, m: RegExpExecArray): Date {
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : (NUMBER_WORDS[m[1]!] ?? 0);
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  if (m[2] === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCDate(d.getUTCDate() + n * (m[2] === 'week' ? 7 : 1));
  return d;
}

function addDays(from: Date, days: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Rule 23b. The ISO date a date-kind start question is answered with; never null. The profile's
 * `earliest_start_date` when set; else read from the `start_date` text ("within N days/weeks/months"
 * is today + N, "immediately"/"asap"/"now" is today + 14 days, "N weeks/months notice" is today +
 * that); else from `notice_period`; else today + 30 days. A Saturday or Sunday rolls to Monday.
 */
export function deriveStartDate(p: ProfileDocument, today: Date): string {
  const set = p.standard_answers.earliest_start_date?.trim();
  if (set) return set;
  const text = (p.standard_answers.start_date ?? '').toLowerCase();
  const notice = (p.standard_answers.notice_period ?? '').toLowerCase();
  let d: Date | null = null;
  const within =
    /\bwithin\s+(?:the\s+next\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*(day|week|month)s?\b/.exec(
      text,
    );
  if (within) d = addDuration(today, within);
  else if (/\b(immediate\w*|asap|as soon as possible|now|right away)\b/.test(text))
    d = addDays(today, 14);
  else {
    const noticeInText = /notice/.test(text) ? DURATION.exec(text) : null;
    const fromNotice = noticeInText ?? DURATION.exec(notice);
    if (fromNotice) d = addDuration(today, fromNotice);
  }
  d ??= addDays(today, 30);
  const dow = d.getUTCDay();
  if (dow === 6) d = addDays(d, 2);
  else if (dow === 0) d = addDays(d, 1);
  return d.toISOString().slice(0, 10);
}

function valueForField(
  profile: ProfileDocument,
  key: StandardKey,
  f: FieldDescriptor,
  today: Date,
): Resolved {
  if (key === 'work_authorization') {
    const text = profileValue(profile, key, f.label);
    if (typeof text !== 'string') return null;
    if (isYesNoField(f)) {
      const authorized = isAuthorizedFor(text, f.label);
      if (authorized === null) return null;
      const mapped = yesNo(authorized, f);
      return mapped === null ? { unexpressible: true } : { value: mapped };
    }
    if (f.options?.length) {
      const hit = matchOption(text, f);
      return hit ? { value: hit } : { unexpressible: true };
    }
    return { value: text };
  }
  // Rule 23b: a date picker always gets a date; a text box keeps the start-date text.
  if (key === 'start_date' && f.type === 'date') return { value: deriveStartDate(profile, today) };
  const value = profileValue(profile, key, f.label);
  if (value === null) return null;
  if (typeof value === 'boolean') {
    const mapped = yesNo(value, f);
    return mapped === null ? { unexpressible: true } : { value: mapped };
  }
  if (f.options?.length) {
    const hit = matchOption(value, f);
    return hit ? { value: hit } : { value };
  }
  return { value };
}

/**
 * Fills `standard` fields from the profile verbatim, with no model call. A required field the
 * profile has no value for resolves to `missing-profile-field` (naming the profile field); an
 * optional one resolves to a blank.
 */
export function resolveStandardFields(
  ctx: Pick<SubmissionContext, 'profile'> & Partial<Pick<SubmissionContext, 'clock'>>,
  fields: Array<FieldDescriptor & { standardKey?: StandardKey }>,
): AnswerResolution[] {
  const out: AnswerResolution[] = [];
  for (const f of fields) {
    if (f.classification !== 'standard') continue;
    const base = { fieldId: f.id, question: f.label };
    const key = f.standardKey ?? standardKeyFor(f.label, f.type, f.description);
    if (!key) {
      out.push(
        f.required
          ? { ...base, status: 'unanswerable' }
          : { ...base, status: 'blank', reason: 'optional-unanswerable' },
      );
      continue;
    }
    const resolved = valueForField(ctx.profile, key, f, ctx.clock?.now() ?? new Date());
    if (resolved === null) {
      out.push(
        f.required
          ? { ...base, status: 'missing-profile-field', profileField: PROFILE_FIELD_NAME[key] }
          : { ...base, status: 'blank', reason: 'optional-unanswerable' },
      );
      continue;
    }
    if ('unexpressible' in resolved) {
      out.push(
        f.required
          ? { ...base, status: 'unanswerable' }
          : { ...base, status: 'blank', reason: 'optional-unanswerable' },
      );
      continue;
    }
    out.push({ ...base, status: 'filled', value: resolved.value, source: 'profile' });
  }
  return out;
}
