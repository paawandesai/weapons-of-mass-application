import { z } from 'zod';
import { activity, getInterview, lockInterview, updateInterview, type TenantHandle } from '@wma/db';

export interface FeedbackView {
  notes: string;
  relayed: string;
  rating: number | null;
  submitted_at: string;
  updated_at: string;
}

/** `{notes, relayed, rating 1..5|null}` as the form sends it; text is trimmed. */
export const FeedbackInput = z
  .object({
    notes: z.string().max(10000).default(''),
    relayed: z.string().max(10000).default(''),
    rating: z.number().int().min(1).max(5).nullable().default(null),
  })
  .strict()
  .transform((v) => ({ notes: v.notes.trim(), relayed: v.relayed.trim(), rating: v.rating }));
export type FeedbackInput = z.output<typeof FeedbackInput>;

export const EMPTY_FEEDBACK_MESSAGE =
  'Add your own notes or the feedback the interviewer shared before saving.';

export function feedbackView(raw: unknown): FeedbackView | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Partial<FeedbackView>;
  if (typeof f.submitted_at !== 'string') return null;
  return {
    notes: typeof f.notes === 'string' ? f.notes : '',
    relayed: typeof f.relayed === 'string' ? f.relayed : '',
    rating: typeof f.rating === 'number' ? f.rating : null,
    submitted_at: f.submitted_at,
    updated_at: typeof f.updated_at === 'string' ? f.updated_at : f.submitted_at,
  };
}

export type SaveFeedbackResult =
  | { status: 'saved'; feedback: FeedbackView; created: boolean }
  | { status: 'not_found' }
  | { status: 'empty' }
  | { status: 'exists' }
  | { status: 'no_feedback' };

/**
 * Rule 8. `create` fails when feedback exists; `edit` fails when none does. Either needs non-empty
 * notes or relayed feedback. An edit keeps `submitted_at` and moves `updated_at`. The interview
 * row is locked for the read-modify-write, and the user-actor activity entry is written in the
 * same transaction. The entry names the fields, never the text.
 */
export async function saveFeedback(
  handle: TenantHandle,
  userId: string,
  interviewId: string,
  mode: 'create' | 'edit',
  input: FeedbackInput,
  now: Date,
): Promise<SaveFeedbackResult> {
  const visible = await getInterview(handle, interviewId);
  if (!visible || visible.userId !== userId) return { status: 'not_found' };
  if (!input.notes && !input.relayed) return { status: 'empty' };

  return handle.transaction(async (h): Promise<SaveFeedbackResult> => {
    const row = await lockInterview(h, interviewId);
    if (!row) return { status: 'not_found' };
    const existing = feedbackView(row.feedback);
    if (mode === 'create' && existing) return { status: 'exists' };
    if (mode === 'edit' && !existing) return { status: 'no_feedback' };
    const stamp = now.toISOString();
    const feedback: FeedbackView = {
      ...input,
      submitted_at: existing?.submitted_at ?? stamp,
      updated_at: stamp,
    };
    await updateInterview(h, interviewId, { feedback });
    await activity.logActivity(h, {
      userId,
      applicationId: row.applicationId,
      actor: 'user',
      action: existing ? 'feedback_edited' : 'feedback_submitted',
      detail: {
        interview_id: interviewId,
        has_notes: input.notes.length > 0,
        has_relayed: input.relayed.length > 0,
        rating: input.rating,
      },
    });
    return { status: 'saved', feedback, created: !existing };
  });
}
