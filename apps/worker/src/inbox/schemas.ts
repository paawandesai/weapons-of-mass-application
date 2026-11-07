import { z } from 'zod';

/** Structured output of the `inbox-link` prompt. */
export const InboxLink = z.object({ application_id: z.string().nullable() });
export type InboxLink = z.infer<typeof InboxLink>;
