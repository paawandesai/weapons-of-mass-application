import type { StructuredLlm } from '@wma/llm';
import { z } from 'zod';
import { callStructured, esc } from '../structured';
import type { FieldClassification, FieldDescriptor } from '../types';

export const STANDARD_KEYS = [
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'location',
  'linkedin',
  'github',
  'website',
  'work_authorization',
  'visa_sponsorship',
  'no_sponsorship_needed',
  'authorized_without_sponsorship',
  'citizenship',
  'payroll_state',
  'worked_before',
  'interviewed_before',
  'applied_before',
  'start_date',
  'notice_period',
  'reasons_for_change',
  'current_company',
  'current_title',
  'relocation',
  'consent',
  'heard_about',
  'travel',
] as const;
export type StandardKey = (typeof STANDARD_KEYS)[number];

/** A field after classification; `standardKey` is set for `standard` fields. */
export type ClassifiedField = FieldDescriptor & { standardKey?: StandardKey };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*:]/g, ' ')
    .replace(/\(optional\)|\(required\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Rule 39: country lists. Each entry is a canonical name followed by its aliases.
const COUNTRY_ALIASES: string[][] = [
  ['United States', 'United States of America', 'USA', 'US', 'U.S.', 'U.S.A.'],
  ['United Kingdom', 'UK', 'U.K.', 'Great Britain', 'Britain'],
  ['Canada'],
  ['Germany'],
  ['France'],
  ['Spain'],
  ['Netherlands', 'The Netherlands'],
  ['Ireland'],
  ['Italy'],
  ['Portugal'],
  ['Poland'],
  ['Sweden'],
  ['Belgium'],
  ['Austria'],
  ['Denmark'],
  ['Finland'],
  ['Australia'],
  ['India'],
  ['Brazil'],
  ['Argentina'],
  ['Mexico'],
  ['Chile'],
  ['Colombia'],
  ['Peru'],
  ['Norway'],
  ['Switzerland'],
  ['Czech Republic', 'Czechia'],
  ['Romania'],
  ['Hungary'],
  ['Greece'],
  ['Turkey', 'Türkiye', 'Turkiye'],
  ['Ukraine'],
  ['Russia', 'Russian Federation'],
  ['Israel'],
  ['United Arab Emirates', 'UAE'],
  ['Saudi Arabia'],
  ['Egypt'],
  ['South Africa'],
  ['Nigeria'],
  ['Kenya'],
  ['China'],
  ['Japan'],
  ['South Korea', 'Korea, Republic of', 'Republic of Korea', 'Korea'],
  ['Singapore'],
  ['Hong Kong'],
  ['Taiwan'],
  ['Thailand'],
  ['Vietnam', 'Viet Nam'],
  ['Philippines', 'The Philippines'],
  ['Indonesia'],
  ['Malaysia'],
  ['Pakistan'],
  ['Bangladesh'],
  ['New Zealand'],
  ['Estonia'],
  ['Latvia'],
  ['Lithuania'],
  ['Croatia'],
  ['Serbia'],
  ['Bulgaria'],
  ['Slovakia'],
  ['Slovenia'],
  ['Luxembourg'],
  ['Iceland'],
  ['Costa Rica'],
  ['Uruguay'],
];

/** Lower-case, accent-free-ish, punctuation-free form used to compare country names. */
function countryKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9à-ɏ]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

const COUNTRY_BY_KEY = new Map<string, string>();
for (const [canonical, ...aliases] of COUNTRY_ALIASES) {
  for (const n of [canonical!, ...aliases]) COUNTRY_BY_KEY.set(countryKey(n), canonical!);
}

/** The canonical country name an option or name denotes, or null. */
export function canonicalCountry(name: string): string | null {
  return COUNTRY_BY_KEY.get(countryKey(name)) ?? null;
}

/** Every canonical country name the list knows, for finding one inside a location string. */
export const COUNTRY_NAMES: string[] = COUNTRY_ALIASES.map((a) => a[0]!);

/** Rule 39: at least 10 options and most of them countries. */
export function hasCountryOptions(options: string[] | undefined): boolean {
  if (!options || options.length < 10) return false;
  const hits = options.filter((o) => canonicalCountry(o) !== null).length;
  return hits * 2 > options.length;
}

// Labels whose country list asks something other than where the candidate lives.
const NOT_RESIDENCE_COUNTRY =
  /\b(citizen\w*|nationalit\w*|birth|born|origin|passport|phone|dial\w*|calling|code|authori[sz]\w*|eligible|sponsor\w*|work\w*|employ\w*)\b/;

/**
 * Rule 39: whether a `location` question is a country list: a label that is just "Country", or a
 * select/combobox whose read options are mostly countries (and whose label does not ask about
 * citizenship, birth or a phone code).
 */
export function isCountryListField(f: Pick<FieldDescriptor, 'label' | 'options'>): boolean {
  const l = norm(f.label);
  if (/^country( of residence)?$|which country/.test(l)) return true;
  return hasCountryOptions(f.options) && !NOT_RESIDENCE_COUNTRY.test(l);
}

const SELF_ID =
  /\b(gender|race|ethnic\w*|hispanic|latino|latina|latinx|veteran|military|disabilit\w*|sexual orientation|transgender|lgbtq\w*|self[- ]identif\w*|equal employment|eeo\w*|protected class|pronouns?)\b/;
// Only a decline that names self-identification: a generic "Prefer not to answer" also appears on
// criminal-history and other attestation questions, which must reach the user, not be skipped.
const DECLINE_OPTION =
  /(decline|prefer not|do(n't| not) wish|choose not|rather not)\b.*\b(self[- ]?identif\w*|identify)\b/;

// Inside a field already known to be self-identification, any option that declines to answer.
const DECLINE_CHOICE =
  /\b(decline|prefer not|do(?:n't| not) (?:wish|want) to|choose not|rather not|not (?:wish|want) to (?:answer|say|disclose|identify))\b/;

/**
 * The option of a self-identification field that declines to answer, or null when the form has
 * none (the field is then left alone, never guessed). Only meaningful for a field classified as
 * self-identification: "Prefer not to answer" elsewhere can be an attestation, not a decline.
 */
export function declineOption(options: string[] | undefined): string | null {
  if (!options) return null;
  return options.find((o) => DECLINE_CHOICE.test(norm(o))) ?? null;
}

// Sponsorship wording, by polarity. "Do you require sponsorship?" is a different question from
// "Can you work without sponsorship?" and from "Are you authorized to work without sponsorship?":
// the first is answered Yes by someone who needs it, the others are answered Yes by someone who
// does not. Each gets its own key so the profile fact is mapped by meaning.
const NEGATED_SPONSORSHIP =
  "(?:\\b(?:without|with no|no need (?:for|of)|not (?:need|needing|require|requiring)|(?:do|does|will|would) not (?:need|require)|don't (?:need|require)|never (?:need|require))\\b[^.?]*\\bsponsor\\w*|\\bsponsor\\w*[^.?]*\\b(?:is|are) not (?:needed|required|necessary))";
const AUTHORIZATION_WORDS =
  '(?:authori[sz]ed|authori[sz]ation|eligible|legally|permitted|allowed to work|able to work|can you work|right to work|work legally)';
const AUTHORIZED_WITHOUT_SPONSORSHIP = new RegExp(
  `^(?=.*${AUTHORIZATION_WORDS})(?=.*${NEGATED_SPONSORSHIP})`,
);
const NO_SPONSORSHIP_NEEDED = new RegExp(NEGATED_SPONSORSHIP);

// A label that acknowledges / agrees to / accepts / consents to / certifies / confirms a policy,
// terms, data processing, or the accuracy of the application. Both a verb and a subject are needed
// in the same label, and an accuracy word alone is not a subject ("confirm your correct legal name"
// is a name field). Applies to checkbox, radio and select fields only (see CONSENT_TYPES).
const CONSENT_VERB =
  '(?:acknowledg\\w*|agree\\w*|accept\\w*|consent\\w*|certif\\w*|confirm\\w*|i have read)';
const CONSENT_SUBJECT =
  '(?:privacy (?:policy|notice|statement)|\\bterms\\b|\\bconditions\\b|data (?:processing|protection)|processing of (?:my|your) (?:personal )?data|\\b(?:information|answers?|statements?|application|details)\\b[^.?]*\\b(?:accurate|true|correct|complete|truthful)\\b|\\b(?:accuracy|truth\\w*)\\b[^.?]*\\b(?:information|answers?|statements?|application)\\b)';
const CONSENT = new RegExp(`^(?=.*\\b${CONSENT_VERB}\\b)(?=.*${CONSENT_SUBJECT})`);
const CONSENT_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio', 'select']);

// Rule 31: an option text that is itself an acknowledgement statement ("I will read the arbitration
// agreement below.", "I confirm I have read the above."). A verb and a subject are both needed.
const ACK_VERB =
  /\b(?:acknowledg\w*|agree\w*|accept\w*|consent\w*|certif\w*|confirm\w*|understand\w*|have read|will read)\b/;
const ACK_SUBJECT =
  /\b(?:agreements?|terms|policy|policies|notice|conditions|arbitrat\w*|the above|the information provided)\b/;

/** Whether an option text is an acknowledgement statement (rule 31). */
export function isAcknowledgementOption(option: string): boolean {
  const o = norm(option);
  return ACK_VERB.test(o) && ACK_SUBJECT.test(o);
}

/**
 * Rule 31: the options themselves are the acknowledgement. A select or radio with exactly one
 * option that is an acknowledgement statement, or a checkbox group with at least one such option.
 */
export function hasAcknowledgementOptions(f: Pick<FieldDescriptor, 'type' | 'options'>): boolean {
  const options = f.options ?? [];
  if (f.type === 'select' || f.type === 'radio') {
    return options.length === 1 && isAcknowledgementOption(options[0]!);
  }
  if (f.type === 'checkbox') return options.some(isAcknowledgementOption);
  return false;
}

// Rule 24b: a label or description that asks the candidate to review, read, understand or confirm
// an AI policy or AI guidelines is an acknowledgement too (Anthropic's "AI Policy for Application").
// The description is part of the match; an options-less dropdown is read as `text`, so text counts.
const AI_POLICY =
  /(?=.*\b(?:review\w*|read|understand\w*|confirm\w*|acknowledg\w*|agree\w*)\b)(?=.*\b(?:ai|artificial intelligence)\b[^.?]{0,40}\b(?:policy|policies|guidelines?)\b)/;
const AI_POLICY_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio', 'select', 'text']);

// Relocation willingness: a relocation word with a willingness word, or a bare "Relocation?" label.
// Assistance / package / cost questions are not willingness and fall to the remaining rules.
const RELOCATION_WILLINGNESS = new RegExp(
  '^(?!.*\\b(?:assist\\w*|package|support|reimburs\\w*|bonus|costs?|expenses?)\\b)' +
    '(?:(?=.*\\brelocat)(?=.*\\b(?:willing\\w*|open|able|prepared|ready|consider\\w*|(?:would|can|could|will) you (?:\\w+ )?relocate)\\b)|(?:relocation|relocate|relocating)\\s*\\??$)',
);

const STANDARD_RULES: Array<[StandardKey, RegExp]> = [
  // Order matters: consent, reasons for change and sponsorship before the generic patterns.
  ['consent', CONSENT],
  [
    'reasons_for_change',
    /reasons? for (leaving|changing|change|looking|seeking)|why (are you|do you want to) (leaving|leave|looking|change|move)|why (are you )?(looking|leaving)/,
  ],
  ['authorized_without_sponsorship', AUTHORIZED_WITHOUT_SPONSORSHIP],
  ['no_sponsorship_needed', NO_SPONSORSHIP_NEEDED],
  ['visa_sponsorship', /sponsor|\bvisa\b/],
  [
    'work_authorization',
    /(authori[sz]ed|eligible|right|permitted|legally able) to work|work authori[sz]ation|work permit|employment eligibility|authori[sz]ation to work|permanent(?:ly)? authori[sz](?:ed|ation)|eligib(?:le|ility) to work|legally (?:able|allowed|entitled) to work/,
  ],
  // Citizenship and export-control "U.S. person" questions, and the state the user would be on
  // payroll in. After work authorization, so "authorized to work" keeps its own key.
  ['citizenship', /\bcitizen(?:ship)?\b|\bu\.?s\.? persons?\b|export control|\bitar\b|nationality/],
  [
    'payroll_state',
    /\bpayroll\b|state (?:or province )?(?:in which|where|of) you (?:will|would|plan to) (?:be )?(?:work|employ|reside|live)/,
  ],
  // Rule 27: prior contact with the company. After sponsorship / work authorization so those keep
  // their labels; before the generic patterns.
  ['worked_before', /\bhave you (?:ever |previously )?worked (?:at|for)\b/],
  ['interviewed_before', /\bhave you (?:ever |previously )?interviewed (?:at|with|for)\b/],
  ['applied_before', /\bhave you (?:ever |previously )?applied (?:to|at|for|with)\b/],
  ['relocation', RELOCATION_WILLINGNESS],
  // Rule 45: where the candidate heard of the role. Before the free-text catch-all sees it.
  [
    'heard_about',
    /how did you (?:hear|find out|learn) (?:about|of)|where did you (?:hear|find|see|learn)|how did you find (?:this|us|the)|^(?:referral |application |lead |candidate )?source(?: of (?:application|referral|hire))?$/,
  ],
  // Rule 46: willingness to travel (an amount up to 25% or none stated; see travelPercent).
  [
    'travel',
    /^(?!.*\b(?:expenses?|reimburs\w*|history|visa|passport|restrictions?)\b)(?=.*\btravel\w*)(?=.*\b(?:willing\w*|able|open|comfortable|prepared|ready|up to|\d{1,3}\s*(?:%|percent)|required|requirement|expect\w*)\b)/,
  ],
  ['notice_period', /notice period/],
  [
    'start_date',
    /(start|starting|available|availability).*\b(date|when)\b|when (can|could|would) you (start|begin|join)|earliest.*start|available to start|availability to start|desired start|start date/,
  ],
  ['current_company', /current (company|employer|organi[sz]ation)|most recent (company|employer)/],
  [
    'current_title',
    /current (job )?title|current (role|position)|most recent (job )?title|present (job )?title/,
  ],
  ['first_name', /\b(first|given) name\b|^first$/],
  ['last_name', /\b(last|family|sur) ?name\b|^last$/],
  ['full_name', /^(your |full |legal |preferred )?name$|\bfull name\b|\blegal name\b/],
  ['email', /e-?mail/],
  ['phone', /\bphone\b|\bmobile\b|\bcell\b|telephone/],
  ['linkedin', /linked-?in/],
  ['github', /git-?hub/],
  [
    'website',
    /^(?!.*\b(?:posts?|articles?|papers?|favou?rite|read|recommend\w*)\b)(?:.*\b(?:website|portfolio)\b|.*\bpersonal (?:site|page|url|blog)\b|.*\byour blog\b)/,
  ],
  [
    'location',
    /^(your |current |home )?(location|city|address|city of residence)\b|^country( of residence)?$|which country|location \(?(city|current)|where are you (currently )?(located|based|living)|current location|city, state|city and country/,
  ],
];

const FREE_TEXT =
  /\b(why|describe|tell us|tell me|explain|what (interests|excites|motivates|attracts)|how did you (hear|find)|cover letter|additional information|anything else|share|experience (with|in)|have you (ever )?(worked|used|built)|years of|what is your (favorite|biggest|greatest))\b/;

/** Standard-field key for a label, or null (rules only; no LLM). */
export function standardKeyFor(label: string, type?: string, description = ''): StandardKey | null {
  const l = norm(label);
  if (
    (type === undefined || AI_POLICY_TYPES.has(type)) &&
    AI_POLICY.test(`${l} ${norm(description)}`) &&
    !SELF_ID.test(l)
  ) {
    return 'consent';
  }
  for (const [key, re] of STANDARD_RULES) {
    // Consent is an acknowledgement control; a text box is never one. Without a type (label-only
    // callers) the label alone decides.
    if (key === 'consent' && type !== undefined && !CONSENT_TYPES.has(type)) continue;
    // Rule 46: more than 25% travel is not inferred; the question goes to the model like any other.
    if (key === 'travel' && (travelPercent(l) ?? 0) > MAX_INFERRED_TRAVEL_PERCENT) continue;
    if (re.test(l)) return key;
  }
  return null;
}

/** Rule 46: the largest share of travel the profile is assumed to accept without saying so. */
export const MAX_INFERRED_TRAVEL_PERCENT = 25;

/** The percentage a travel question names ("up to 25%", "50 percent"), or null when none. */
export function travelPercent(label: string): number | null {
  const m = /(\d{1,3})\s*(?:%|percent)/i.exec(label);
  return m ? Number(m[1]) : null;
}

interface RuleVerdict {
  classification: FieldClassification;
  standardKey?: StandardKey;
}

/** Rule-based verdict, or null when no rule recognises the field. */
export function classifyByRules(
  f: Pick<FieldDescriptor, 'label' | 'type' | 'options' | 'description'>,
): RuleVerdict | null {
  const l = norm(f.label);
  if (SELF_ID.test(l)) return { classification: 'self-identification' };
  if (f.options?.some((o) => DECLINE_OPTION.test(norm(o)))) {
    return { classification: 'self-identification' };
  }
  if (f.type === 'file') {
    return /resume|\bcv\b|curriculum vitae/.test(l)
      ? { classification: 'resume' }
      : { classification: 'free-text' };
  }
  const key = standardKeyFor(f.label, f.type, f.description);
  if (key) return { classification: 'standard', standardKey: key };
  if (hasAcknowledgementOptions(f)) return { classification: 'standard', standardKey: 'consent' };
  if (isCountryListField(f)) return { classification: 'standard', standardKey: 'location' };
  if (FREE_TEXT.test(l) || f.type === 'textarea') return { classification: 'free-text' };
  return null;
}

const fallbackSchema = z.object({
  fields: z.array(
    z.object({
      id: z.string(),
      classification: z.enum(['standard', 'free-text', 'self-identification', 'resume']),
    }),
  ),
});

/**
 * Sets `classification` on every field (rules first, so a self-identification label never
 * depends on a model). Labels no rule recognises go to the model in one batch; without a model, or
 * if the call fails, they are treated as free-text. The model's `standard` is ignored for labels
 * that have no profile mapping.
 */
export async function classifyFields(
  fields: FieldDescriptor[],
  llm?: StructuredLlm,
): Promise<ClassifiedField[]> {
  const verdicts = fields.map((f) => classifyByRules(f));
  const unknown = fields.filter((_, i) => verdicts[i] === null);
  const fromModel = new Map<string, FieldClassification>();
  if (unknown.length > 0 && llm) {
    try {
      const out = await callStructured(
        llm,
        'classify-form-field',
        `<fields>\n${esc(JSON.stringify(unknown.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options }))))}\n</fields>`,
        fallbackSchema,
      );
      for (const r of out.fields) fromModel.set(r.id, r.classification);
    } catch {
      // Unrecognised labels fall back to free-text below.
    }
  }
  return fields.map((f, i) => {
    const v = verdicts[i];
    if (v) return { ...f, ...v };
    const m = fromModel.get(f.id);
    const classification: FieldClassification =
      m === 'self-identification' || (m === 'resume' && f.type === 'file') ? m : 'free-text';
    return { ...f, classification };
  });
}
