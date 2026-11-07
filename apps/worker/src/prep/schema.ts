import { z } from 'zod';

/** Structured output of the `prep-plan` prompt: the four sections of the study guide. */
export const PrepPlan = z.object({
  likely_questions: z
    .array(z.object({ question: z.string().min(1), answer_outline: z.string().min(1) }))
    .min(1)
    .max(15),
  topics: z.array(z.string().min(1)).min(1).max(15),
  company_research: z.string().min(1).max(4000),
  interviewer_background: z.string().min(1).nullable(),
});
export type PrepPlan = z.infer<typeof PrepPlan>;
