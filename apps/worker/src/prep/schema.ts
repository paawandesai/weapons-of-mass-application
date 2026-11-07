import { z } from 'zod';

/** Structured output of the `prep-plan` prompt: the four sections of the study guide. */
const clampList = <T>(max: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v.slice(0, max) : v), z.array(z.custom<T>()).min(1));
const clampText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : v), z.string().min(1));

// The wire schema sent to the model carries no maxItems/maxLength (structured outputs reject
// them), so a long reply is clamped here instead of rejected: the first 15 questions and topics
// and the first 4,000 characters of research are the plan.
export const PrepPlan = z.object({
  likely_questions: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 15) : v),
    z.array(z.object({ question: z.string().min(1), answer_outline: z.string().min(1) })).min(1),
  ),
  topics: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 15) : v),
    z.array(z.string().min(1)).min(1),
  ),
  company_research: clampText(4000),
  interviewer_background: z.string().min(1).nullable(),
});
void clampList;
export type PrepPlan = z.infer<typeof PrepPlan>;
