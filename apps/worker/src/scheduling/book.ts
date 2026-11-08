import { randomUUID } from 'node:crypto';
import {
  activity,
  applyTransition,
  getInterview,
  getInterviewSlot,
  getEmailThread,
  lockInterview,
  recordFollowOnJob,
  updateInterviewIfGeneration,
  type InterviewRow,
  type TenantHandle,
} from '@wma/db';
import { PREP_PLAN_JOB, prepPlanKey, sendEmailRecovering } from '@wma/shared';
import { isGoogleAuthError } from './auth';
import { loadApplicationContext } from './offer';
import { eventDetails, recruiterReply } from './templates';
import type { SchedulingDeps } from './types';

export interface BookInput {
  userId: string;
  interviewId: string;
}

export type BookResult =
  | { status: 'not_confirmed' }
  /** A reschedule or a newer confirmation replaced the slot this booking was for; nothing more was written. */
  | { status: 'stale' }
  /** The confirmed time had already started when the booking ran; no reply and no event. */
  | { status: 'expired' }
  | { status: 'reply_blocked' }
  | { status: 'booked'; eventId: string; created: boolean };

export class EventCreationError extends Error {
  readonly code = 'event_failed' as const;
  constructor(options?: { cause?: unknown }) {
    super('the calendar event could not be written; the reply is already sent', options);
    this.name = 'EventCreationError';
  }
}

/** The recruiter reply's send may or may not have been accepted; it is not repeated. The job retries and reconciles. */
export class ReplyUncertainError extends Error {
  readonly code = 'reply_uncertain' as const;
  constructor() {
    super('an earlier recruiter reply for this slot has an unknown outcome; not sending again');
    this.name = 'ReplyUncertainError';
  }
}

/** Delivery key of the acceptance for one interview and confirmed slot. */
export const recruiterReplyKey = (interviewId: string, slotId: string) =>
  `recruiter_reply:${interviewId}:${slotId}`;

/** A Calendar-valid event id: 32 lowercase hex characters (the allowed alphabet is a-v and 0-9). */
const newEventId = () => randomUUID().replace(/-/g, '');

type ReplyStep =
  | { kind: 'stale' }
  | { kind: 'blocked' }
  | { kind: 'done'; interviewer: string | null; interview: InterviewRow };

/**
 * Design rule 10, run only after the user confirmed a slot. In order: schedule the reminders
 * (they do not depend on the recruiter), reply on the recruiter thread once, create or update the
 * Calendar event, move the card to Interviewing and log `interview_booked`.
 *
 * Serialization: the interview row is locked while the reply context is read and the reply is
 * sent, and every write is conditioned on the confirmed-slot generation read at the start, so a
 * reschedule or a newer confirmation either waits for the reply step or turns this booking into a
 * no-op (`stale`). The reply is recorded by a delivery key `recruiter_reply:<interview>:<slot>`
 * before Gmail is called, so a crash after the send recovers from the receipt instead of
 * re-sending. The Calendar event id is generated on the client and persisted before the insert:
 * a retry finds the same event. `booked_generation` is written last; until then the hourly repair
 * pass keeps the interview in its queue.
 */
export async function bookInterview(
  handle: TenantHandle,
  input: BookInput,
  deps: SchedulingDeps,
): Promise<BookResult> {
  const interview = await getInterview(handle, input.interviewId);
  if (!interview || interview.userId !== input.userId) return { status: 'not_confirmed' };
  if (
    !interview.confirmedSlotId ||
    !interview.confirmedAt ||
    !interview.startsAt ||
    !interview.endsAt
  ) {
    return { status: 'not_confirmed' };
  }
  const generation = interview.confirmedGeneration;
  const slot = await getInterviewSlot(handle, interview.confirmedSlotId);
  // An interview recorded from a confirmation email or by hand has no slot and may have no
  // thread; neither reaches here (no confirmed slot), so a missing thread is simply not bookable.
  const thread = interview.threadId ? await getEmailThread(handle, interview.threadId) : null;
  if (!slot || !thread) return { status: 'not_confirmed' };
  const ctx = await loadApplicationContext(handle, input.userId, interview.applicationId);
  const when = { start: interview.startsAt, end: interview.endsAt };

  // A delayed booking for a time that has begun is rejected, not acted on.
  if (when.start <= deps.clock.now()) {
    await activity.logActivity(handle, {
      userId: input.userId,
      applicationId: interview.applicationId,
      actor: 'agent',
      action: 'interview_booking_expired',
      detail: { interview_id: interview.id, slot_id: slot.id, starts_at: when.start.toISOString() },
    });
    return { status: 'expired' };
  }

  // 0. Reminders at confirmation, whether or not the recruiter reply goes out. A failure here is
  // logged and never holds back the reply; the repair pass and a retry schedule them again.
  try {
    await deps.scheduleReminders(handle, interview.id);
  } catch (e) {
    await activity.logActivity(handle, {
      userId: input.userId,
      applicationId: interview.applicationId,
      actor: 'agent',
      action: 'reminder_schedule_failed',
      detail: { interview_id: interview.id, error: e instanceof Error ? e.name : 'error' },
    });
  }

  // 1. Reply, once, with the interview row locked.
  const step: ReplyStep = await handle.transaction(async (h): Promise<ReplyStep> => {
    const locked = await lockInterview(h, interview.id);
    if (!locked || !locked.confirmedSlotId || locked.confirmedGeneration !== generation) {
      return { kind: 'stale' };
    }
    if (locked.replySentAt) return { kind: 'done', interviewer: null, interview: locked };
    const key = recruiterReplyKey(interview.id, slot.id);

    // Recover from the receipt of an earlier attempt that sent but did not record the marker.
    const receipt = await deps.mail.store.findByKey(key);
    if (receipt?.state === 'sent') {
      const marked = await updateInterviewIfGeneration(h, interview.id, generation, {
        replySentAt: receipt.createdAt,
      });
      return marked ? { kind: 'done', interviewer: null, interview: marked } : { kind: 'stale' };
    }

    const target = await deps.mailbox.replyContext(thread.gmailThreadId, ctx.user.email);
    const result = await sendEmailRecovering(deps.mail, {
      ...recruiterReply({
        userId: input.userId,
        applicationId: interview.applicationId,
        to: target.to,
        subject: target.subject,
        recruiterName: target.fromName,
        senderName: ctx.user.displayName,
        companyName: ctx.companyName,
        jobTitle: ctx.jobTitle,
        zone: ctx.user.timezone,
        slot: when,
        threadId: thread.gmailThreadId,
        ...(target.inReplyTo ? { inReplyTo: target.inReplyTo } : {}),
        ...(target.references ? { references: target.references } : {}),
      }),
      deliveryKey: key,
    });
    if (result.status === 'blocked') return { kind: 'blocked' };
    if (result.status === 'uncertain') throw new ReplyUncertainError();
    const marked = await updateInterviewIfGeneration(h, interview.id, generation, {
      replySentAt: deps.clock.now(),
    });
    if (!marked) return { kind: 'stale' };
    await activity.logActivity(h, {
      userId: input.userId,
      applicationId: interview.applicationId,
      actor: 'agent',
      action: 'interview_reply_sent',
      detail: { interview_id: interview.id, slot_id: slot.id },
    });
    return { kind: 'done', interviewer: target.fromName, interview: marked };
  });
  if (step.kind === 'stale') return { status: 'stale' };
  if (step.kind === 'blocked') return { status: 'reply_blocked' };

  // 2. Event: create on the first booking (idempotent by its client id), update after a reschedule.
  let interviewer = step.interviewer;
  if (interviewer === null) {
    // Name the interviewer where the thread shows one; a failed lookup never blocks the event.
    interviewer = await deps.mailbox
      .replyContext(thread.gmailThreadId, ctx.user.email)
      .then((t) => t.fromName)
      .catch(() => null);
  }
  const origin = deps.webOrigin.replace(/\/+$/, '');
  const event = {
    ...eventDetails({
      companyName: ctx.companyName,
      jobTitle: ctx.jobTitle,
      interviewer,
      prepLink: step.interview.prepPlan
        ? `${origin}/applications/${interview.applicationId}`
        : null,
    }),
    start: when.start,
    end: when.end,
    timeZone: ctx.user.timezone,
  };

  // The client id is persisted BEFORE the insert so a crash or a lost response retries the same event.
  const clientId = await handle.transaction(async (h) => {
    const locked = await lockInterview(h, interview.id);
    if (!locked || locked.confirmedGeneration !== generation || !locked.confirmedSlotId) {
      return null;
    }
    if (locked.calendarEventClientId) return locked.calendarEventClientId;
    const id = newEventId();
    const saved = await updateInterviewIfGeneration(h, interview.id, generation, {
      calendarEventClientId: id,
    });
    return saved ? id : null;
  });
  if (clientId === null) return { status: 'stale' };

  const current = await getInterview(handle, interview.id);
  if (!current || current.confirmedGeneration !== generation) return { status: 'stale' };
  let eventId = current.calendarEventId;
  const created = eventId === null;
  try {
    if (eventId === null)
      eventId = (await deps.calendar.createEvent({ ...event, id: clientId })).id;
    else await deps.calendar.updateEvent(eventId, event);
  } catch (e) {
    // A revoked grant must reach the job unchanged so the connection is marked revoked.
    if (isGoogleAuthError(e)) throw e;
    await activity.logActivity(handle, {
      userId: input.userId,
      applicationId: interview.applicationId,
      actor: 'agent',
      action: 'interview_event_failed',
      detail: { interview_id: interview.id, slot_id: slot.id },
    });
    throw new EventCreationError({ cause: e });
  }
  if (created) {
    const saved = await updateInterviewIfGeneration(handle, interview.id, generation, {
      calendarEventId: eventId,
    });
    if (!saved) return { status: 'stale' };
  }

  // 3. Card and log; the generation is marked booked only once everything above is done.
  const finished = await handle.transaction(async (h) => {
    const locked = await lockInterview(h, interview.id);
    if (!locked || locked.confirmedGeneration !== generation || !locked.confirmedSlotId) {
      return false;
    }
    const change = await applyTransition(h, interview.applicationId, 'interview');
    if (change.changed) {
      await activity.logActivity(h, {
        userId: input.userId,
        applicationId: interview.applicationId,
        actor: 'agent',
        action: 'status_changed',
        detail: { from: change.from, to: change.to, source: 'interview_booked' },
      });
    }
    // The prep plan follows the booking: recorded with it, sent to the queue by the reconciler.
    // A plan that already exists is left alone. Never holds back or undoes the booking.
    await recordFollowOnJob(h, {
      userId: input.userId,
      kind: PREP_PLAN_JOB,
      payload: {
        tenantId: h.tenantId,
        userId: input.userId,
        interviewId: interview.id,
        onlyIfMissing: true,
      },
      dedupeKey: prepPlanKey(interview.id),
    });
    const alreadyBooked = locked.bookedGeneration === generation;
    await updateInterviewIfGeneration(h, interview.id, generation, {
      bookedGeneration: generation,
    });
    if (!alreadyBooked) {
      await activity.logActivity(h, {
        userId: input.userId,
        applicationId: interview.applicationId,
        actor: 'agent',
        action: 'interview_booked',
        detail: {
          interview_id: interview.id,
          slot_id: slot.id,
          event_id: eventId,
          starts_at: when.start.toISOString(),
          event_created: created,
        },
      });
    }
    return true;
  });
  if (!finished) return { status: 'stale' };

  return { status: 'booked', eventId: eventId!, created };
}
