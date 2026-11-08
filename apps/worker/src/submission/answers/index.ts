import { classifyFields, declineOption, type ClassifiedField } from './classify';
import { resolveFreeText } from './freetext';
import { resolveStandardFields } from './standard';
import type { AnswerResolution, FieldDescriptor, FieldValues, SubmissionContext } from '../types';

export {
  classifyFields,
  classifyByRules,
  declineOption,
  standardKeyFor,
  STANDARD_KEYS,
  type ClassifiedField,
  type StandardKey,
} from './classify';
export {
  resolveStandardFields,
  profileValue,
  deriveStartDate,
  companyAsked,
  normalizeCompany,
} from './standard';
export { resolveFreeText, maxChars, DEFAULT_MAX_ANSWER_CHARS } from './freetext';

/** Name of the stored resume file shown as the resolved value of a resume field. */
export const RESUME_FILENAME = 'resume.pdf';

/**
 * Resolves every field of a form, in order (rules 7 and 8):
 * self-identification is recorded as skipped, unless the profile says to decline and the form has a
 * decline option, which is then chosen; the resume field is recorded as
 * the stored resume file (attachResume uploads it); standard fields come from the profile;
 * everything else is answered by the model or left blank. The caller parks the application on the
 * first `missing-profile-field` or `unanswerable` and writes `toFormAnswers(...)` before submit.
 */
export async function resolveAnswers(
  ctx: Pick<SubmissionContext, 'profile' | 'job' | 'llm'> &
    Partial<Pick<SubmissionContext, 'companyName' | 'priorApplications'>>,
  fields: FieldDescriptor[],
): Promise<AnswerResolution[]> {
  const classified: ClassifiedField[] = await classifyFields(fields, ctx.llm);
  const standard = new Map(
    resolveStandardFields(ctx, classified).map((r) => [r.fieldId, r] as const),
  );
  const out: AnswerResolution[] = [];
  for (const f of classified) {
    const base = { fieldId: f.id, question: f.label };
    switch (f.classification) {
      case 'self-identification': {
        // Only when the user chose to decline, and only a decline option the form itself offers.
        const decline =
          ctx.profile.standard_answers.self_identification_default === 'decline'
            ? declineOption(f.options)
            : null;
        out.push(
          decline === null
            ? { ...base, status: 'skipped', skipped: 'self-identification' }
            : {
                ...base,
                status: 'filled',
                value: f.type === 'checkbox' ? [decline] : decline,
                source: 'profile',
              },
        );
        break;
      }
      case 'resume':
        out.push({ ...base, status: 'filled', value: RESUME_FILENAME, source: 'profile' });
        break;
      case 'standard':
        out.push(standard.get(f.id) as AnswerResolution);
        break;
      case 'free-text':
        out.push(await resolveFreeText(ctx, f));
        break;
    }
  }
  return out;
}

/** Values to hand to `adapter.fill`: filled fields only; file fields go through attachResume. */
export function toFieldValues(
  resolutions: AnswerResolution[],
  fields: FieldDescriptor[],
): FieldValues {
  const files = new Set(fields.filter((f) => f.type === 'file').map((f) => f.id));
  const values: FieldValues = {};
  for (const r of resolutions) {
    if (r.status === 'filled' && !files.has(r.fieldId)) values[r.fieldId] = r.value;
  }
  return values;
}

type FormAnswer =
  | string
  | boolean
  | string[]
  | { skipped: 'self-identification' }
  | { value: string | boolean | string[]; source: 'inferred' | 'guessed' }
  | null;

/**
 * The record stored in `applications.form_answers`, keyed by exact question text: the entered
 * value, `{skipped: "self-identification"}`, or null for a field left blank. Unresolved fields
 * (`unanswerable`, `missing-profile-field`) are omitted: the application parks before submit.
 */
export function toFormAnswers(resolutions: AnswerResolution[]): Record<string, FormAnswer> {
  const out: Record<string, FormAnswer> = {};
  for (const r of resolutions) {
    if (r.status === 'filled') {
      out[r.question] =
        r.source === 'inferred' || r.source === 'guessed'
          ? { value: r.value, source: r.source }
          : r.value;
    } else if (r.status === 'skipped') out[r.question] = { skipped: r.skipped };
    else if (r.status === 'blank') out[r.question] = null;
  }
  return out;
}

/** The first resolution that parks the application, with its pending reason; null when none. */
export function firstBlocker(resolutions: AnswerResolution[]): {
  reason: 'missing-profile-field' | 'unanswerable-question';
  resolution: AnswerResolution;
} | null {
  for (const r of resolutions) {
    if (r.status === 'missing-profile-field')
      return { reason: 'missing-profile-field', resolution: r };
    if (r.status === 'unanswerable') return { reason: 'unanswerable-question', resolution: r };
  }
  return null;
}
