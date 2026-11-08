import { z } from 'zod';
import {
  getApplication,
  markFollowOnDispatched,
  recordConfirmedInterview,
  type InterviewRow,
  type TenantHandle,
} from '@wma/db';
import { isActionable, prepPlanKey } from '@wma/shared';
import type { PrepQueue } from './prep';

export const DEFAULT_INTERVIEW_MINUTES = 60;

/** ISO 8601 timestamps; `ends_at` defaults to an hour after the start. */
export const RecordInterviewInput = z.object({
  starts_at: z.string().min(1),
  ends_at: z.string().min(1).nullable().optional(),
});
export type RecordInterviewInput = z.infer<typeof RecordInterviewInput>;

export type RecordInterviewResult =
  | { status: 'not_found' }
  | { status: 'closed' }
  | { status: 'invalid_time'; message: string }
  | {
      status: 'recorded';
      interview: InterviewRow;
      /** False when the queue declined or was down; the outbox and repair passes cover it. */
      enqueued: boolean;
    };

/**
 * The user booked an interview outside the app (on the employer's scheduling page, by phone) and
 * types the time in. Stores it as a confirmed, booked interview with no thread, moves the card
 * to Interviewing and records reminders and the prep plan in the outbox; the plan is also handed
 * to the queue directly so the card shows it pending at once. A closed application takes no
 * interview; a time that has started is refused.
 */
export async function recordInterview(
  handle: TenantHandle,
  userId: string,
  applicationId: string,
  input: RecordInterviewInput,
  queue: PrepQueue,
  now: Date,
): Promise<RecordInterviewResult> {
  const application = await getApplication(handle, applicationId);
  if (!application || application.userId !== userId) return { status: 'not_found' };
  if (!isActionable(application)) return { status: 'closed' };

  const startsAt = new Date(input.starts_at);
  if (Number.isNaN(startsAt.getTime()))
    return { status: 'invalid_time', message: 'The start time could not be read.' };
  const endsAt = input.ends_at
    ? new Date(input.ends_at)
    : new Date(startsAt.getTime() + DEFAULT_INTERVIEW_MINUTES * 60_000);
  if (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt)
    return { status: 'invalid_time', message: 'The end time must come after the start.' };
  if (startsAt <= now)
    return { status: 'invalid_time', message: 'The interview time must be in the future.' };

  const { interview } = await recordConfirmedInterview(handle, {
    userId,
    applicationId: application.id,
    threadId: null,
    startsAt,
    endsAt,
    bookedVia: 'manual',
  });

  // Fast path; the outbox row already covers a queue that is down.
  const job = { tenantId: handle.tenantId, userId, interviewId: interview.id };
  let enqueued = false;
  try {
    enqueued = await queue.enqueuePrepPlan(job);
    await markFollowOnDispatched(handle, prepPlanKey(interview.id));
  } catch {
    enqueued = false;
  }
  return { status: 'recorded', interview, enqueued };
}
