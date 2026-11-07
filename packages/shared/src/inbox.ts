import { z } from 'zod';

export const Classification = z.enum(['confirmation', 'rejection', 'interview', 'offer', 'other']);
export type Classification = z.infer<typeof Classification>;

export const ProposedSlot = z.object({
  /** ISO 8601 with an explicit offset. */
  start: z.string(),
  end: z.string().nullable(),
  tz_hint: z.string().nullable(),
  /** The model could not resolve the time unambiguously; such slots are dropped with a note. */
  ambiguous: z.boolean(),
});
export type ProposedSlot = z.infer<typeof ProposedSlot>;

/** Structured output of the `inbox-classify` prompt (design rule 3). */
export const InboxClassification = z.object({
  classification: Classification,
  compensation_flag: z.boolean(),
  booking_link: z.string().nullable(),
  proposed_slots: z.array(ProposedSlot),
  /** The email moves, cancels or re-proposes a time already agreed in this thread (rule 53). */
  reschedule: z.boolean().default(false),
});
export type InboxClassification = z.infer<typeof InboxClassification>;

export const InboxClassificationJsonSchema = z.toJSONSchema(InboxClassification) as Record<
  string,
  unknown
>;
