import { SubmissionFailure } from './failure';
import type { AnswerResolution, FieldDescriptor, FieldValues } from './types';

export interface FillPlan {
  /** Values to type into the form, by field id. */
  values: FieldValues;
  /** What `applications.form_answers` records, by exact question text. */
  answers: Record<string, unknown>;
  /** The form's resume upload, when it has one. */
  resumeField: FieldDescriptor | null;
}

/**
 * Turns the resolver's output into what gets entered and what gets recorded. Self-identification
 * fields are filled only with the form's decline option, when the profile says to decline. The first field, in form order, that cannot be filled ends the plan
 * with the pending reason that names it.
 */
export function planFill(fields: FieldDescriptor[], resolutions: AnswerResolution[]): FillPlan {
  const byId = new Map(resolutions.map((r) => [r.fieldId, r]));
  const values: FieldValues = {};
  const answers: Record<string, unknown> = {};
  let resumeField: FieldDescriptor | null = null;

  for (const f of fields) {
    if (f.classification === 'self-identification') {
      // Entered only when the resolver chose the form's decline option (the profile says to decline).
      const chosen = byId.get(f.id);
      if (chosen?.status === 'filled') {
        values[f.id] = chosen.value;
        answers[f.label] = chosen.value;
      } else {
        answers[f.label] = { skipped: 'self-identification' };
      }
      continue;
    }
    if (f.classification === 'resume') {
      resumeField ??= f;
      continue;
    }
    // The only upload the agent can supply is the resume.
    if (f.type === 'file') {
      if (f.required) throw new SubmissionFailure('unmapped-field', { field: f.label });
      answers[f.label] = null;
      continue;
    }
    const r = byId.get(f.id);
    if (!r) {
      if (f.required) throw new SubmissionFailure('unmapped-field', { field: f.label });
      answers[f.label] = null;
      continue;
    }
    switch (r.status) {
      case 'filled':
        if (f.required && (r.value === '' || (Array.isArray(r.value) && r.value.length === 0))) {
          throw new SubmissionFailure('unmapped-field', { field: f.label });
        }
        values[f.id] = r.value;
        // Inferred and guessed answers are recorded with their source so they can be shown as such.
        answers[f.label] =
          r.source === 'inferred' || r.source === 'guessed'
            ? { value: r.value, source: r.source }
            : r.value;
        break;
      case 'skipped':
        answers[f.label] = { skipped: r.skipped };
        break;
      case 'blank':
        if (f.required && r.reason === 'optional-unanswerable') {
          throw new SubmissionFailure('unanswerable-question', { question: f.label });
        }
        answers[f.label] = null;
        break;
      case 'unanswerable':
        if (f.required) throw new SubmissionFailure('unanswerable-question', { question: f.label });
        answers[f.label] = null;
        break;
      case 'missing-profile-field':
        if (f.required) throw new SubmissionFailure('missing-profile-field', { field: f.label });
        answers[f.label] = null;
        break;
    }
  }
  return { values, answers, resumeField };
}
