import { z } from 'zod';
import type { ProfileDocument } from '@wma/shared';
import { callStructured, esc } from '../structured';
import type { AnswerResolution, FieldDescriptor, SubmissionContext } from '../types';

export const ANSWER_PROMPT = 'answer-form-question';
/** Spec: answers are at most this long when the field declares no maximum. */
export const DEFAULT_MAX_ANSWER_CHARS = 1200;

export const answerSchema = z.object({
  answer: z.string(),
  grounded: z.boolean(),
  unanswerable: z.boolean(),
  /** Quoted claims the model could not source; used to word the single retry. */
  ungrounded_claims: z.array(z.string()),
});
export type AnswerOutput = z.infer<typeof answerSchema>;

export function maxChars(field: Pick<FieldDescriptor, 'maxLength'>): number {
  return field.maxLength && field.maxLength > 0 ? field.maxLength : DEFAULT_MAX_ANSWER_CHARS;
}

function profileForModel(p: ProfileDocument) {
  return {
    identity: p.identity,
    work_history: p.work_history.map(({ sources: _s, ...w }) => w),
    projects: p.projects.map(({ sources: _s, ...x }) => x),
    skills: p.skills,
    education: p.education.map(({ sources: _s, ...x }) => x),
  };
}

function userMessage(
  ctx: Pick<SubmissionContext, 'profile' | 'job'>,
  field: FieldDescriptor,
  rejected: string | null,
): string {
  const question = {
    question: field.label,
    field_type: field.type,
    options: field.options ?? null,
    max_length_chars: maxChars(field),
  };
  const posting = {
    title: ctx.job.title,
    location: ctx.job.location,
    description: ctx.job.description,
  };
  const parts = [
    `<question>\n${esc(JSON.stringify(question))}\n</question>`,
    `<profile>\n${esc(JSON.stringify(profileForModel(ctx.profile), null, 1))}\n</profile>`,
    `<posting>\n${esc(JSON.stringify(posting, null, 1))}\n</posting>`,
  ];
  if (rejected) parts.push(`<rejected>\n${esc(rejected)}\n</rejected>`);
  return parts.join('\n\n');
}

/** Cuts at the last sentence end within the limit; null when there is none. */
function trimToSentence(text: string, limit: number): string | null {
  const head = text.slice(0, limit);
  const m = /^[\s\S]*[.!?](?=\s|$)/.exec(head);
  return m && m[0].trim().length > 0 ? m[0].trim() : null;
}

type Checked =
  { ok: true; value: string | boolean | string[] } | { ok: false; why: string; tooLong?: true };

/** A grouped checkbox takes the chosen options: each item must be one of the field's options. */
function checkGroup(options: string[], text: string): Checked {
  const wrong = () => ({
    ok: false as const,
    why: `list only options from: ${options.join(' | ')}, separated by new lines`,
  });
  const byLower = new Map(options.map((o) => [o.trim().toLowerCase(), o] as const));
  let items: string[];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return wrong();
      items = parsed as string[];
    } catch {
      return wrong();
    }
  } else {
    const whole = byLower.get(text.toLowerCase());
    items = whole ? [whole] : text.split(/[\n;|]/);
    if (!whole && items.length === 1) items = text.split(',');
  }
  const chosen: string[] = [];
  for (const raw of items.map((x) => x.trim()).filter(Boolean)) {
    const hit = byLower.get(raw.toLowerCase());
    if (!hit) return wrong();
    if (!chosen.includes(hit)) chosen.push(hit);
  }
  return chosen.length > 0 ? { ok: true, value: chosen } : wrong();
}

function checkAnswer(field: FieldDescriptor, out: AnswerOutput): Checked {
  const text = out.answer.trim();
  if (text === '')
    return { ok: false, why: 'the answer is empty; answer it or mark it unanswerable' };
  if (field.type === 'checkbox' && field.options && field.options.length > 0) {
    return checkGroup(field.options, text);
  }
  if (field.options && field.options.length > 0 && field.type !== 'checkbox') {
    const hit = field.options.find((o) => o.trim().toLowerCase() === text.toLowerCase());
    return hit
      ? { ok: true, value: hit }
      : { ok: false, why: `the answer must be exactly one of: ${field.options.join(' | ')}` };
  }
  if (field.type === 'checkbox') return { ok: true, value: /^(yes|true|y)\b/i.test(text) };
  const limit = maxChars(field);
  if (text.length > limit) {
    return {
      ok: false,
      why: `the answer is ${text.length} characters; the maximum is ${limit}`,
      tooLong: true,
    };
  }
  return { ok: true, value: text };
}

/**
 * Rule 8. One model call per attempt, at most two attempts. `unanswerable` ends it at once;
 * `grounded = false` (or an answer that breaks the length or options contract) gets one retry that
 * quotes the problem; after that the field is unanswerable. Unanswerable resolves to a blank when
 * the field is optional and to `unanswerable` (parks the application) when it is required. File
 * fields are never generated. Model transport errors propagate.
 */
export async function resolveFreeText(
  ctx: Pick<SubmissionContext, 'profile' | 'job' | 'llm'>,
  field: FieldDescriptor,
): Promise<AnswerResolution> {
  const base = { fieldId: field.id, question: field.label };
  const unanswerable = (): AnswerResolution =>
    field.required
      ? { ...base, status: 'unanswerable' }
      : { ...base, status: 'blank', reason: 'optional-unanswerable' };
  if (field.type === 'file') return unanswerable();

  let rejected: string | null = null;
  let tooLong: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out: AnswerOutput = await callStructured(
      ctx.llm,
      ANSWER_PROMPT,
      userMessage(ctx, field, rejected),
      answerSchema,
    );
    if (out.unanswerable) return unanswerable();
    tooLong = null;
    if (!out.grounded) {
      const claims = out.ungrounded_claims.length
        ? out.ungrounded_claims.map((c) => `"${c}"`).join('; ')
        : 'some claims';
      rejected = `The answer was not grounded in the profile or posting. Ungrounded: ${claims}. Remove or correct them, or mark the question unanswerable.`;
      continue;
    }
    const checked = checkAnswer(field, out);
    if (checked.ok) return { ...base, status: 'filled', value: checked.value, source: 'generated' };
    rejected = `Rejected: ${checked.why}.`;
    if (checked.tooLong) tooLong = out.answer.trim();
  }
  // Second attempt failed. A grounded answer that was only too long is cut at a sentence end.
  if (tooLong !== null) {
    const cut = trimToSentence(tooLong, maxChars(field));
    if (cut) return { ...base, status: 'filled', value: cut, source: 'generated' };
  }
  return unanswerable();
}
