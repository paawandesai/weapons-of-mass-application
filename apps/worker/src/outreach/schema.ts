import { z } from 'zod';
import { MAX_LINKEDIN_NOTE, MAX_OUTREACH_BODY, MAX_OUTREACH_SUBJECT } from '@wma/shared';

const clamp = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().slice(0, max) : v), z.string().min(1));

/** Structured output of the `outreach-draft` prompt. Long replies are clamped, not rejected. */
export const OutreachDraft = z.object({
  subject: clamp(MAX_OUTREACH_SUBJECT),
  body: clamp(MAX_OUTREACH_BODY),
  linkedin_note: clamp(MAX_LINKEDIN_NOTE),
});
export type OutreachDraft = z.infer<typeof OutreachDraft>;
