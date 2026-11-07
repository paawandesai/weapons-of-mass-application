import type { FieldClassification, FieldDescriptor } from '../types';

/** The parts of a scanned question that classification reads. */
export interface RawField {
  id: string;
  label: string;
  type: FieldDescriptor['type'];
  required: boolean;
  maxLength: number | null;
  options?: string[];
  /** Section id, class, heading text and control names: the vendor-structure signal. */
  hint: string;
  /** Step index on multi-step forms, otherwise null. */
  step: number | null;
}

const SELF_ID_SECTION = /(^|[^a-z])(eeoc?|self[- ]?identif|voluntary|demographic|diversity)/i;
const SELF_ID_LABEL =
  /\b(gender|race|ethnic\w*|hispanic|latino|latinx|veteran|disabilit\w*|sexual orientation|transgender|lgbtq?\w*)\b/i;
const RESUME_LABEL = /\b(resume|r[eé]sum[eé]|cv|curriculum vitae)\b/i;

const STANDARD_LABEL: RegExp[] = [
  /^(first|given|legal first|preferred first) name\b/i,
  /^(last|family|sur|legal last) ?name\b/i,
  /^(full|legal|preferred)? ?name$/i,
  /\be-?mail\b/i,
  /\b(phone|mobile|telephone)\b/i,
  /\b(location|located|city|country|address|zip|postal|state\b|province|time ?zone)/i,
  /\b(linkedin|github|twitter|portfolio|website|personal site|url)\b/i,
  /\bcurrent (company|employer|title|role)\b/i,
  /\b(authori[sz]ed to work|work authori[sz]ation|right to work|visa|sponsorship|legally)\b/i,
  /\b(relocat\w*|notice period|start date|available to start|salary|compensation)\b/i,
  /\b(how did you (hear|find)|referred by|pronouns?)\b/i,
  /\b(privacy|consent|acknowledge|agree|terms|gdpr)\b/i,
];

/**
 * Rule-based classification (design D2). Order matters: self-identification wins over everything
 * so a voluntary EEO field is never treated as an answerable question, then the resume field,
 * then recognized profile-backed labels. Anything else is `free-text`, answered from the profile
 * by the answers step (or parked as unanswerable); the LLM label fallback belongs to that step.
 */
export function classifyField(raw: Pick<RawField, 'label' | 'type' | 'hint'>): FieldClassification {
  if (SELF_ID_SECTION.test(raw.hint) || SELF_ID_LABEL.test(raw.label)) return 'self-identification';
  if (raw.type === 'file' && (RESUME_LABEL.test(raw.label) || /resume|\bcv\b/i.test(raw.hint))) {
    return 'resume';
  }
  if (raw.type !== 'file' && STANDARD_LABEL.some((re) => re.test(raw.label))) return 'standard';
  return 'free-text';
}
