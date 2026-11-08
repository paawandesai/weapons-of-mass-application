import { and, eq, sql } from 'drizzle-orm';
import {
  PREP_PLAN_JOB,
  prepPlanKey,
  SCHEDULE_REMINDERS_JOB,
  scheduleRemindersKey,
} from '@wma/shared';
import { logActivity } from '../activity';
import type { TenantHandle } from '../client';
import { interviews } from '../schema';
import { applyTransition, type AppliedTransition } from './applications';
import { invalidateOpenSlots } from './interview_slots';
import {
  getInterviewByThread,
  lockInterview,
  recordFollowOnJob,
  type InterviewRow,
} from './interviews';

/** How an interview time was fixed outside the app's own slot flow. */
export type BookedVia = 'email' | 'manual';

export interface ConfirmedInterviewInput {
  userId: string;
  applicationId: string;
  /** The recruiter thread that confirmed the time; null when the user typed it in. */
  threadId: string | null;
  startsAt: Date;
  endsAt: Date;
  bookedVia: BookedVia;
  /** Extra fields for the `interview_recorded` activity entry (the Gmail message id, say). */
  detail?: Record<string, unknown>;
}

export interface ConfirmedInterviewResult {
  /** `unchanged`: the thread's interview was already confirmed for this very time. */
  status: 'recorded' | 'rescheduled' | 'unchanged';
  interview: InterviewRow;
  statusChange: AppliedTransition;
}

/**
 * Records an interview whose time is already fixed: stated by a confirmation email (the
 * candidate picked it on the employer's scheduling page) or typed in by the user. There is no
 * slot to confirm, no reply owed to the recruiter and no Calendar event to create, so the row is
 * written confirmed AND booked in one step; the booking job and its repair pass never pick it up
 * (both key off `confirmed_slot_id`). Reminders are the caller's: schedule them after the
 * transaction commits. Also moves the card to Interviewing and records the prep plan in the
 * outbox (`onlyIfMissing`), all in the caller's transaction.
 *
 * A thread that already has an interview is updated in place: a different time replaces it (open
 * slots invalidated, generation bumped so a booking in flight for the old time turns into a
 * no-op), the same time changes nothing. A Calendar event from an earlier in-app booking is kept
 * as it is and the activity entry says so.
 *
 * Reminders and the prep plan are recorded in the outbox with the row, so the worker's reconciler
 * schedules both even if the process dies right after the commit.
 */
export function recordConfirmedInterview(
  handle: TenantHandle,
  input: ConfirmedInterviewInput,
): Promise<ConfirmedInterviewResult> {
  return handle.transaction(async (h) => {
    const existing = input.threadId ? await getInterviewByThread(h, input.threadId) : null;
    let interview: InterviewRow;
    let status: ConfirmedInterviewResult['status'];
    let eventKept = false;
    if (existing) {
      const locked = (await lockInterview(h, existing.id)) ?? existing;
      if (locked.confirmedAt && locked.startsAt?.getTime() === input.startsAt.getTime()) {
        return {
          status: 'unchanged',
          interview: locked,
          statusChange: { changed: false, reason: 'no_change', from: null },
        };
      }
      status = locked.confirmedAt ? 'rescheduled' : 'recorded';
      eventKept = locked.calendarEventId !== null;
      await invalidateOpenSlots(h, locked.id);
      const next = sql`${interviews.confirmedGeneration} + 1`;
      const rows = await h.run((tx) =>
        tx
          .update(interviews)
          .set({
            confirmedSlotId: null,
            confirmedAt: sql`now()`,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            confirmationEmailSentAt: null,
            confirmedGeneration: next,
            bookedGeneration: next,
            bookedVia: input.bookedVia,
          })
          .where(and(eq(interviews.tenantId, h.tenantId), eq(interviews.id, locked.id)))
          .returning(),
      );
      interview = rows[0]!;
    } else {
      status = 'recorded';
      const rows = await h.run((tx) =>
        tx
          .insert(interviews)
          .values({
            tenantId: h.tenantId,
            userId: input.userId,
            applicationId: input.applicationId,
            threadId: input.threadId,
            confirmedAt: sql`now()`,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            confirmedGeneration: 1,
            bookedGeneration: 1,
            bookedVia: input.bookedVia,
          })
          .returning(),
      );
      interview = rows[0]!;
    }

    const statusChange = await applyTransition(h, input.applicationId, 'interview');
    if (statusChange.changed) {
      await logActivity(h, {
        userId: input.userId,
        applicationId: input.applicationId,
        actor: input.bookedVia === 'manual' ? 'user' : 'agent',
        action: 'status_changed',
        detail: {
          from: statusChange.from,
          to: statusChange.to,
          source: 'interview_recorded',
        },
      });
    }
    const job = { tenantId: h.tenantId, userId: input.userId, interviewId: interview.id };
    await recordFollowOnJob(h, {
      userId: input.userId,
      kind: SCHEDULE_REMINDERS_JOB,
      payload: job,
      dedupeKey: scheduleRemindersKey(interview.id, interview.confirmedGeneration),
    });
    // The prep plan follows the booking, as it does for a slot confirmation.
    await recordFollowOnJob(h, {
      userId: input.userId,
      kind: PREP_PLAN_JOB,
      payload: { ...job, onlyIfMissing: true },
      dedupeKey: prepPlanKey(interview.id),
    });
    await logActivity(h, {
      userId: input.userId,
      applicationId: input.applicationId,
      actor: input.bookedVia === 'manual' ? 'user' : 'agent',
      action: 'interview_recorded',
      detail: {
        interview_id: interview.id,
        starts_at: input.startsAt.toISOString(),
        ends_at: input.endsAt.toISOString(),
        booked_via: input.bookedVia,
        rescheduled: status === 'rescheduled',
        ...(eventKept ? { calendar_event_kept: true } : {}),
        ...(input.threadId ? { thread_id: input.threadId } : {}),
        ...(input.detail ?? {}),
      },
    });
    return { status, interview, statusChange };
  });
}
