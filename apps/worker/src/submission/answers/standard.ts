import type { ProfileDocument } from '@wma/shared';
import type { AnswerResolution, FieldDescriptor, SubmissionContext } from '../types';
import {
  canonicalCountry,
  COUNTRY_NAMES,
  hasAcknowledgementOptions,
  isAcknowledgementOption,
  isCountryListField,
  MAX_INFERRED_TRAVEL_PERCENT,
  standardKeyFor,
  travelPercent,
  type StandardKey,
} from './classify';

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
  citizenship: 'standard_answers.citizenship',
  payroll_state: 'standard_answers.payroll_state',
  worked_before: 'work_history',
  interviewed_before: 'standard_answers.previous_interviews',
  applied_before: 'standard_answers.previous_interviews',
  start_date: 'standard_answers.start_date',
  notice_period: 'standard_answers.notice_period',
  reasons_for_change: 'standard_answers.reasons_for_change',
  current_company: 'work_history.0.employer',
  current_title: 'work_history.0.title',
  relocation: 'survey.willing_to_relocate',
  consent: 'standard_answers.consent',
  heard_about: 'application source (not a profile field)',
  travel: 'travel willingness (not a profile field)',
};

/** What the resolver knows beyond the profile: the posting's company and earlier applied rows. */
export interface PriorContact {
  /** The posting's company display name. */
  companyName?: string;
  /** Names of companies the user has an applied application for. */
  priorApplications?: string[];
  /** The posting's location text, for the relocation inference. */
  jobLocation?: string | null;
}

const COMPANY_SUFFIX =
  /\b(?:inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pbc|ag|sa)\b/g;

/** A company name reduced to what identifies it: lowercase letters and digits, suffixes dropped. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(COMPANY_SUFFIX, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_COMPANY =
  /^(?:this|our|the|us|we|this company|the company|this organi[sz]ation|our company)$/;

/**
 * Rule 27: the company a prior-contact question asks about. The name after "at/to/for/with" when
 * the label names one; otherwise (no name, or "this company") the posting's company.
 */
export function companyAsked(question: string, posting: string | undefined): string | null {
  const m =
    /\b(?:worked|interviewed|applied)\s+(?:at|for|with|to)\s+(.+?)(?:\s+(?:before|previously|in the past|already|ever)\b.*|[?.]*)$/i.exec(
      question.trim(),
    );
  const named = m?.[1]?.replace(/^(?:the|a|an)\s+/i, '').trim() ?? '';
  const generic = named === '' || GENERIC_COMPANY.test(named.toLowerCase());
  const name = generic ? posting : named;
  return name && normalizeCompany(name) !== '' ? name : null;
}

const sameCompany = (a: string, b: string) => normalizeCompany(a) === normalizeCompany(b);

function priorContact(
  p: ProfileDocument,
  key: 'worked_before' | 'interviewed_before' | 'applied_before',
  question: string,
  prior: PriorContact,
): boolean | null {
  const company = companyAsked(question, prior.companyName);
  if (company === null) return null;
  const interviews = p.standard_answers.previous_interviews;
  const interviewed = interviews?.some((c) => sameCompany(c, company)) ?? false;
  if (key === 'worked_before') return p.work_history.some((w) => sameCompany(w.employer, company));
  if (key === 'interviewed_before') return interviews == null ? null : interviewed;
  if (interviewed || (prior.priorApplications ?? []).some((c) => sameCompany(c, company))) {
    return true;
  }
  return interviews == null ? null : false;
}

function currentRole(p: ProfileDocument) {
  return p.work_history.find((w) => w.end_date === null) ?? p.work_history[0] ?? null;
}

/** The raw profile value for a standard key, or null when the profile has none. */
export function profileValue(
  p: ProfileDocument,
  key: StandardKey,
  question = '',
  prior: PriorContact = {},
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
    case 'citizenship': {
      const text = nonEmpty(p.standard_answers.citizenship);
      if (!text) return null;
      // A yes/no question about citizenship or being a "U.S. person" is answered from the text;
      // a text or list field gets the text itself.
      const personQuestion = /\bu\.?s\.? persons?\b|export control|\bitar\b/i.test(question);
      const isUsCitizen =
        /\b(?:u\.?s\.?a?|united states|american)\b.*\bcitizen|\bcitizen\b.*\b(?:u\.?s\.?a?|united states)\b/i.test(
          text,
        );
      const isUsPerson =
        isUsCitizen || /permanent resident|green card|lawful(?:ly)? admitted/i.test(text);
      if (personQuestion) return isUsPerson;
      if (/country of citizenship|nationality/i.test(question))
        return isUsCitizen ? 'United States' : text;
      return isUsCitizen ? true : text;
    }
    case 'payroll_state':
      return nonEmpty(p.standard_answers.payroll_state);
    case 'worked_before':
    case 'interviewed_before':
    case 'applied_before':
      return priorContact(p, key, question, prior);
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
    case 'heard_about':
    case 'travel':
      // Not profile facts; rules 45 and 46 infer them (inferValue / heardAbout).
      return null;
  }
}

// Rule 45: the answer to "how did you hear about this role", most honest first. The agent found
// the posting on the company's own board, so a job-board or careers-site option wins; "Other" is
// the fallback when the list offers nothing closer.
const HEARD_ABOUT_OPTIONS: RegExp[] = [
  /\bjob board\b|\bjob (?:site|listing|posting|search)\b/i,
  /\bcareers? (?:site|page|website)\b|\bcompany (?:website|site)\b|\bour website\b|\bwebsite\b/i,
  /\bonline\b|\binternet\b|\bweb search\b|\bsearch engine\b|\bgoogle\b/i,
  /\blinkedin\b/i,
  /\bother\b/i,
];
const HEARD_ABOUT_TEXT = 'Job board';

function heardAbout(f: FieldDescriptor): Resolved {
  if (!f.options?.length) return { value: HEARD_ABOUT_TEXT, inferred: true };
  for (const re of HEARD_ABOUT_OPTIONS) {
    const hit = f.options.find((o) => re.test(o));
    if (hit) return { value: hit, inferred: true };
  }
  return { unexpressible: true };
}

// Places a work-authorization answer or a question can name. A group "covers" the places it lists.
const PLACES: Array<{ id: string; re: RegExp; covers?: string[] }> = [
  {
    id: 'us',
    re: /\bu\.s\.?a?\b|\busa\b|united states|\b(?:in|the) us\b|\bus (?:citizen|work|based|resident)/,
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

/**
 * Rule 32: whether a question naming several places asks about any of them ("the U.S. or Canada",
 * "either", "any of") rather than every one ("and", "both"). Mixed or ambiguous wording stays
 * every-place, the conservative reading.
 */
function namesAnyOfPlaces(question: string): boolean {
  const t = question.toLowerCase();
  const spans = PLACES.map((p) => {
    const m = p.re.exec(t);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  }).filter((x): x is { start: number; end: number } => x !== null);
  if (spans.length < 2) return false;
  const start = Math.min(...spans.map((x) => x.start));
  const end = Math.max(...spans.map((x) => x.end));
  const between = t.slice(start, end);
  const before = t.slice(Math.max(0, start - 24), start);
  if (/\bboth\b/.test(before) || /\band\b/.test(between)) return false;
  return /\bor\b/.test(between) || /\b(?:either|any of|one of)\s*(?:the\s+)?$/.test(before);
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
  const covers = (id: string) =>
    [...held].some((h) => h === id || (PLACES.find((p) => p.id === h)?.covers ?? []).includes(id));
  // Rule 32: "A or B" needs one covered place, "A and B" every one.
  return (namesAnyOfPlaces(question) ? [...asked].some(covers) : [...asked].every(covers))
    ? true
    : null;
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

type Resolved =
  { value: string | boolean | string[]; inferred?: true } | { unexpressible: true } | null;

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

// Rule 28: inference helpers. Used only when the profile holds no value.
const PLACE_NAME: Record<string, string> = {
  us: 'the United States',
  uk: 'the United Kingdom',
  ca: 'Canada',
  de: 'Germany',
  fr: 'France',
  es: 'Spain',
  nl: 'the Netherlands',
  ie: 'Ireland',
  it: 'Italy',
  pt: 'Portugal',
  pl: 'Poland',
  se: 'Sweden',
  be: 'Belgium',
  at: 'Austria',
  dk: 'Denmark',
  fi: 'Finland',
  au: 'Australia',
  in: 'India',
  br: 'Brazil',
};
const US_STATE_CODES =
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(
    ' ',
  );
const US_STATE_NAMES =
  /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const US_CITIES =
  /\b(?:san francisco|los angeles|san diego|san jose|seattle|portland|austin|boston|chicago|denver|atlanta|miami|brooklyn|manhattan|philadelphia|houston|dallas|oakland|palo alto|mountain view|pittsburgh|washington,? d\.?c)\b/i;
const CA_CITIES =
  /\b(?:toronto|vancouver|montreal|ottawa|calgary|ontario|british columbia|quebec)\b/i;
const UK_CITIES =
  /\b(?:london|manchester|edinburgh|glasgow|bristol|birmingham|cambridge|oxford)\b/i;

/** The country (a PLACES id) a location text names or implies, or null. */
function locationCountryId(loc: string): string | null {
  if (loc) {
    const named = placesIn(loc);
    for (const id of Object.keys(PLACE_NAME)) if (named.has(id)) return id;
    if (CA_CITIES.test(loc)) return 'ca';
    if (UK_CITIES.test(loc)) return 'uk';
    const code = /,\s*([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:USA?|U\.S\.A?\.?))?$/.exec(
      loc,
    );
    if (code && US_STATE_CODES.includes(code[1]!)) return 'us';
    if (US_STATE_NAMES.test(loc) || US_CITIES.test(loc)) return 'us';
  }
  return null;
}

/** The country (a PLACES id) the profile's location or phone implies, or null. */
function profileCountry(p: ProfileDocument): string | null {
  const fromLocation = locationCountryId(p.identity.location?.trim() ?? '');
  if (fromLocation) return fromLocation;
  const phone = p.contact.phone?.replace(/[\s().-]/g, '') ?? '';
  if (/^\+1\d{10}$/.test(phone)) return 'us';
  if (/^\+44/.test(phone)) return 'uk';
  return null;
}

/**
 * Rule 39: the canonical country name `identity.location` implies (rule 28's place table, then any
 * country in the list named in the text), or null.
 */
function countryNameFromLocation(loc: string | null | undefined): string | null {
  const text = loc?.trim() ?? '';
  if (!text) return null;
  const id = locationCountryId(text);
  if (id) return canonicalCountry(PLACE_NAME[id]!);
  const lower = text.toLowerCase();
  return COUNTRY_NAMES.find((n) => new RegExp(`\\b${n.toLowerCase()}\\b`).test(lower)) ?? null;
}

/**
 * An inferred work-authorization statement for a question: the country the profile implies, else
 * the countries the question itself names, else null (the question is then the user's to answer).
 * When the profile implies a country the question must be covered by it.
 */
function inferredAuthorization(p: ProfileDocument, question: string): string | null {
  const home = profileCountry(p);
  if (home) {
    const statement = `Authorized to work in ${PLACE_NAME[home]}`;
    return isAuthorizedFor(statement, question) === true ? statement : null;
  }
  const asked = [...placesIn(question)].filter((id) => PLACE_NAME[id]);
  if (asked.length === 0) return null;
  return `Authorized to work in ${asked.map((id) => PLACE_NAME[id]).join(' and ')}`;
}

function locationMatches(posting: string, wanted: string[]): boolean {
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const p = norm(posting);
  return (
    p !== '' &&
    wanted.some((w) => {
      const n = norm(w);
      return n !== '' && (p.includes(n) || n.includes(p));
    })
  );
}

/** The inferred value for a standard key the profile leaves null, or null when none is defensible. */
function inferValue(
  p: ProfileDocument,
  key: StandardKey,
  question: string,
  prior: PriorContact,
): string | boolean | null {
  const sa = p.standard_answers;
  const authInferable =
    sa.work_authorization === null && inferredAuthorization(p, question) !== null;
  switch (key) {
    case 'visa_sponsorship':
      return sa.visa_sponsorship_required === null && authInferable ? false : null;
    case 'no_sponsorship_needed':
      return sa.visa_sponsorship_required === null && authInferable ? true : null;
    case 'authorized_without_sponsorship': {
      const required = sa.visa_sponsorship_required;
      if (required === true) return null;
      if (!authInferable) return null;
      return true;
    }
    case 'interviewed_before':
    case 'applied_before':
      return priorContact(
        { ...p, standard_answers: { ...sa, previous_interviews: [] } },
        key,
        question,
        prior,
      );
    case 'start_date':
      return 'Within 30 days';
    case 'notice_period':
      return '2 weeks';
    case 'travel':
      // Rule 46: travel up to MAX_INFERRED_TRAVEL_PERCENT (or no amount named) is accepted;
      // standardKeyFor leaves larger shares to the model.
      return (travelPercent(question) ?? 0) <= MAX_INFERRED_TRAVEL_PERCENT ? true : null;
    case 'relocation':
      if (p.survey.willing_to_relocate !== null) return null;
      if (p.preferences.remote === 'remote') return false;
      return prior.jobLocation
        ? locationMatches(prior.jobLocation, p.preferences.locations)
        : false;
    default:
      return null;
  }
}

function valueForField(
  profile: ProfileDocument,
  key: StandardKey,
  f: FieldDescriptor,
  today: Date,
  prior: PriorContact,
  allowInference: boolean,
): Resolved {
  if (key === 'work_authorization') {
    const explicit = profileValue(profile, key, f.label, prior);
    const inferred = typeof explicit !== 'string' && allowInference;
    const text =
      typeof explicit === 'string'
        ? explicit
        : inferred && profile.standard_answers.work_authorization === null
          ? inferredAuthorization(profile, f.label)
          : null;
    if (typeof text !== 'string') return null;
    const flag = text === explicit ? {} : { inferred: true as const };
    if (isYesNoField(f)) {
      const authorized = isAuthorizedFor(text, f.label);
      if (authorized === null) return null;
      const mapped = yesNo(authorized, f);
      return mapped === null ? { unexpressible: true } : { value: mapped, ...flag };
    }
    if (f.options?.length) {
      const hit = matchOption(text, f);
      return hit ? { value: hit, ...flag } : { unexpressible: true };
    }
    return { value: text, ...flag };
  }
  // Rule 39: a country list takes the country the profile's location implies; a city/state
  // question keeps the location text (the generic path below).
  if (key === 'location' && isCountryListField(f)) {
    const country = countryNameFromLocation(profile.identity.location);
    if (!country) return null;
    if (f.options?.length) {
      const hit = f.options.find((o) => canonicalCountry(o) === country);
      return hit ? { value: hit } : { unexpressible: true };
    }
    // No options recorded (a large-list combobox): the canonical name; the fill picks the
    // containing match.
    return { value: country };
  }
  // Rule 31: the options are the acknowledgement. A lone select/radio option is taken as it is; a
  // checkbox group has every acknowledgement option checked and nothing else.
  if (key === 'consent' && f.options?.length) {
    if ((f.type === 'select' || f.type === 'radio') && f.options.length === 1) {
      if (isAcknowledgementOption(f.options[0]!)) return { value: f.options[0]! };
    } else if (f.type === 'checkbox' && f.options.length === 1) {
      // Rule 34: a lone checkbox carries its own statement as its only option; it takes a boolean.
      if (isAcknowledgementOption(f.options[0]!)) return { value: true };
    } else if (f.type === 'checkbox') {
      const acks = f.options.filter(isAcknowledgementOption);
      if (acks.length > 0) return { value: acks };
    }
  }
  // Rule 45: where the candidate heard about the role is never a profile fact.
  if (key === 'heard_about') return allowInference ? heardAbout(f) : null;
  // Rule 23b: a date picker always gets a date; a text box keeps the start-date text.
  if (key === 'start_date' && f.type === 'date') return { value: deriveStartDate(profile, today) };
  let value = profileValue(profile, key, f.label, prior);
  let flag: { inferred?: true } = {};
  // authorized_without_sponsorship: an explicit sponsorship answer with no stated authorization
  // falls through to the inference too.
  if (value === null && allowInference) {
    value = inferValue(profile, key, f.label, prior);
    if (value !== null) flag = { inferred: true };
  }
  if (value === null) return null;
  if (typeof value === 'boolean') {
    const mapped = yesNo(value, f);
    return mapped === null ? { unexpressible: true } : { value: mapped, ...flag };
  }
  if (f.options?.length) {
    const hit =
      matchOption(value, f) ??
      (key === 'citizenship' && canonicalCountry(value)
        ? f.options.find((o) => canonicalCountry(o) === canonicalCountry(value))
        : undefined);
    return hit ? { value: hit, ...flag } : { value, ...flag };
  }
  return { value, ...flag };
}

/**
 * Fills `standard` fields from the profile verbatim, with no model call. A required field the
 * profile has no value for resolves to `missing-profile-field` (naming the profile field); an
 * optional one resolves to a blank.
 */
export function resolveStandardFields(
  ctx: Pick<SubmissionContext, 'profile'> &
    Partial<Pick<SubmissionContext, 'clock' | 'companyName' | 'priorApplications' | 'job'>>,
  fields: Array<FieldDescriptor & { standardKey?: StandardKey }>,
): AnswerResolution[] {
  const out: AnswerResolution[] = [];
  for (const f of fields) {
    if (f.classification !== 'standard') continue;
    const base = { fieldId: f.id, question: f.label };
    const key =
      f.standardKey ??
      standardKeyFor(f.label, f.type, f.description) ??
      (hasAcknowledgementOptions(f) ? 'consent' : null);
    if (!key) {
      out.push(
        f.required
          ? { ...base, status: 'unanswerable' }
          : { ...base, status: 'blank', reason: 'optional-unanswerable' },
      );
      continue;
    }
    const resolved = valueForField(
      ctx.profile,
      key,
      f,
      ctx.clock?.now() ?? new Date(),
      {
        companyName: ctx.companyName,
        priorApplications: ctx.priorApplications,
        jobLocation: ctx.job?.location ?? null,
      },
      f.required,
    );
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
    out.push({
      ...base,
      status: 'filled',
      value: resolved.value,
      source: resolved.inferred ? 'inferred' : 'profile',
    });
  }
  return out;
}
