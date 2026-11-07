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
  'start_date',
  'notice_period',
  'reasons_for_change',
  'current_company',
  'current_title',
  'relocation',
  'consent',
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

const SELF_ID =
  /\b(gender|race|ethnic\w*|hispanic|latino|latina|latinx|veteran|military|disabilit\w*|sexual orientation|transgender|lgbtq\w*|self[- ]identif\w*|equal employment|eeo\w*|protected class|pronouns?)\b/;
// Only a decline that names self-identification: a generic "Prefer not to answer" also appears on
// criminal-history and other attestation questions, which must reach the user, not be skipped.
const DECLINE_OPTION =
  /(decline|prefer not|do(n't| not) wish|choose not|rather not)\b.*\b(self[- ]?identif\w*|identify)\b/;

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
    /(authori[sz]ed|eligible|right|permitted|legally able) to work|work authori[sz]ation|work permit|employment eligibility/,
  ],
  ['relocation', RELOCATION_WILLINGNESS],
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
  ['website', /\bwebsite\b|\bportfolio\b|personal (site|url|page)|\bblog\b/],
  [
    'location',
    /^(your |current |home )?(location|city|address|city of residence)\b|location \(?(city|current)|where are you (currently )?(located|based|living)|current location|city, state|city and country/,
  ],
];

const FREE_TEXT =
  /\b(why|describe|tell us|tell me|explain|what (interests|excites|motivates|attracts)|how did you (hear|find)|cover letter|additional information|anything else|share|experience (with|in)|have you (ever )?(worked|used|built)|years of|what is your (favorite|biggest|greatest))\b/;

/** Standard-field key for a label, or null (rules only; no LLM). */
export function standardKeyFor(label: string, type?: string): StandardKey | null {
  const l = norm(label);
  for (const [key, re] of STANDARD_RULES) {
    // Consent is an acknowledgement control; a text box is never one. Without a type (label-only
    // callers) the label alone decides.
    if (key === 'consent' && type !== undefined && !CONSENT_TYPES.has(type)) continue;
    if (re.test(l)) return key;
  }
  return null;
}

interface RuleVerdict {
  classification: FieldClassification;
  standardKey?: StandardKey;
}

/** Rule-based verdict, or null when no rule recognises the field. */
export function classifyByRules(
  f: Pick<FieldDescriptor, 'label' | 'type' | 'options'>,
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
  const key = standardKeyFor(f.label, f.type);
  if (key) return { classification: 'standard', standardKey: key };
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
