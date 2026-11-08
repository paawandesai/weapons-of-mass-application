import { activity, recordConfirmedInterview, type TenantHandle } from '@wma/db';
import type { ProposedSlot } from '@wma/shared';
import { loadApplicationContext } from './offer';
import { normalizeSlots } from './slots';
import type { SchedulingDeps } from './types';

export interface ConfirmedFromEmailInput {
  userId: string;
  applicationId: string;
  /** `email_threads.id` of the thread that confirmed the time. */
  threadId: string;
  /** Gmail id of the confirming message (recorded in the activity log). */
  messageId: string;
  slot: ProposedSlot;
}

/**
 * The email says the interview is booked for one time (the candidate picked it on the
 * employer's scheduling page, or the recruiter fixed it). Nothing is offered or replied to: the
 * time is normalized like a proposed slot (explicit offset, not ambiguous, in the future, an hour
 * long when no end is stated) and stored as a confirmed, booked interview in the CALLER'S
 * transaction, with the reminders and the prep plan recorded in the outbox alongside. An
 * unusable time stores nothing and leaves a `confirmed_time_unusable` activity entry; the card
 * still moved to Interviewing on the classification alone.
 */
export async function recordConfirmedFromEmail(
  handle: TenantHandle,
  input: ConfirmedFromEmailInput,
  deps: Pick<SchedulingDeps, 'clock'>,
): Promise<{ interviewId: string | null }> {
  const ctx = await loadApplicationContext(handle, input.userId, input.applicationId);
  const { slots, notes } = normalizeSlots([input.slot], deps.clock.now(), ctx.user.timezone);
  const slot = slots[0];
  if (!slot) {
    await activity.logActivity(handle, {
      userId: input.userId,
      applicationId: input.applicationId,
      actor: 'agent',
      action: 'confirmed_time_unusable',
      detail: {
        thread_id: input.threadId,
        gmail_message_id: input.messageId,
        stated: input.slot.start,
        notes,
      },
    });
    return { interviewId: null };
  }
  const result = await recordConfirmedInterview(handle, {
    userId: input.userId,
    applicationId: input.applicationId,
    threadId: input.threadId,
    startsAt: slot.start,
    endsAt: slot.end,
    bookedVia: 'email',
    detail: { gmail_message_id: input.messageId, tz_hint: slot.tzHint },
  });
  return { interviewId: result.interview.id };
}
