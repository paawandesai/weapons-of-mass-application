import {
  activity,
  getInterview,
  getUserById,
  hasActivityWithDetail,
  listApplicationLabels,
  type InterviewRow,
  type TenantHandle,
} from '@wma/db';
import { SCHEDULE_REMINDERS_JOB, sendEmailRecovering } from '@wma/shared';
import { REMINDER_JOB, REMINDER_OFFSETS_S, type ReminderOffset } from './constants';
import type { NotificationDeps } from './deps';
import { cardUrl, prepPlanUrl } from './links';
import { renderReminder } from './templates';

export interface ReminderJobData {
  tenantId: string;
  userId: string;
  interviewId: string;
  /** Seconds before the start. */
  offset: ReminderOffset;
  /** The start time this reminder was scheduled for (ISO); a changed start makes it stale. */
  startsAt: string;
}

export interface ScheduleRemindersJobData {
  tenantId: string;
  userId: string;
  interviewId: string;
  /** Which retry this is when an earlier attempt found an old reminder still running. */
  attempt?: number;
}

export type ReminderScheduleDeps = Pick<NotificationDeps, 'queue' | 'now'>;

/** An old reminder that is still running holds its singleton key for a moment; the replacement retries after this. */
export const SCHEDULE_RETRY_BASE_S = 30;
export const SCHEDULE_RETRY_MAX_ATTEMPTS = 6;

/** Delivery key of one reminder: the interview, the offset and the start it was scheduled for. */
export const reminderDeliveryKey = (interviewId: string, offset: number, startsAtIso: string) =>
  `reminder:${interviewId}:${offset}:${startsAtIso}`;

/** Singleton key `(interview_id, offset)`. */
export const reminderKey = (interviewId: string, offset: number) => `${interviewId}:${offset}`;

export interface ScheduledReminder {
  offset: ReminderOffset;
  runAt: Date;
}

/** Cancels the queued reminders of an interview (every offset). Returns how many were cancelled. */
export async function cancelReminders(
  interviewId: string,
  deps: Pick<NotificationDeps, 'queue'>,
): Promise<number> {
  let n = 0;
  for (const offset of REMINDER_OFFSETS_S) {
    n += await deps.queue.cancelByKey(REMINDER_JOB, reminderKey(interviewId, offset));
  }
  return n;
}

/**
 * Schedules the T-24h and T-1h reminders of a confirmed interview (design rule 13). Existing
 * queued reminders for the interview are cancelled first, so a reschedule replaces them; an
 * offset whose moment has already passed is skipped (an interview confirmed 5 hours out gets
 * only the 1-hour reminder). An interview that is not confirmed schedules nothing.
 */
export async function scheduleReminders(
  handle: TenantHandle,
  interviewId: string,
  deps: ReminderScheduleDeps,
  attempt = 0,
): Promise<ScheduledReminder[]> {
  await cancelReminders(interviewId, deps);
  const interview = await getInterview(handle, interviewId);
  if (!interview || !interview.confirmedAt || !interview.startsAt) return [];
  const now = deps.now().getTime();
  const scheduled: ScheduledReminder[] = [];
  let deferred = false;
  for (const offset of REMINDER_OFFSETS_S) {
    const runAt = new Date(interview.startsAt.getTime() - offset * 1000);
    if (runAt.getTime() <= now) continue;
    const data: ReminderJobData = {
      tenantId: handle.tenantId,
      userId: interview.userId,
      interviewId,
      offset,
      startsAt: interview.startsAt.toISOString(),
    };
    const id = await deps.queue.send(REMINDER_JOB, data, {
      singletonKey: reminderKey(interviewId, offset),
      startAfter: runAt,
      retryLimit: 3,
      retryDelay: 60,
    });
    if (id === null) {
      // The old reminder for this offset is running (cancel only reaches queued jobs) and the
      // exclusive queue refused the replacement. It will see the changed start and skip, so
      // schedule again shortly instead of losing the new one.
      deferred = true;
      continue;
    }
    scheduled.push({ offset, runAt });
  }
  if (deferred && attempt < SCHEDULE_RETRY_MAX_ATTEMPTS) {
    const next = attempt + 1;
    const job: ScheduleRemindersJobData = {
      tenantId: handle.tenantId,
      userId: interview.userId,
      interviewId,
      attempt: next,
    };
    await deps.queue.send(SCHEDULE_REMINDERS_JOB, job, {
      singletonKey: `${interviewId}:retry:${next}`,
      startAfter: new Date(now + SCHEDULE_RETRY_BASE_S * 2 ** attempt * 1000),
      retryLimit: 0,
    });
  }
  return scheduled;
}

export type ReminderOutcome =
  | { status: 'sent'; outgoingId: string }
  | { status: 'blocked'; outgoingId: string }
  | {
      status: 'skipped';
      reason: 'not_confirmed' | 'rescheduled' | 'already_sent' | 'in_the_past';
    };

/** The interviewer's name when scheduling recorded one on the slot activity; otherwise unknown. */
async function interviewerFor(
  handle: TenantHandle,
  interview: InterviewRow,
): Promise<string | null> {
  const entries = await activity.listByApplication(handle, interview.applicationId, { limit: 200 });
  for (const e of entries) {
    if (e.action !== 'slot_confirmed' && e.action !== 'slots_offered') continue;
    const name = (e.detail as { interviewer?: unknown } | null)?.interviewer;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

/**
 * The reminder job. A reminder whose interview is no longer confirmed, whose start has changed
 * since it was scheduled, or that has already gone out is a no-op, so a cancel that raced the
 * queue never produces a send.
 */
export async function runReminder(
  handle: TenantHandle,
  data: ReminderJobData,
  deps: NotificationDeps,
): Promise<ReminderOutcome> {
  const interview = await getInterview(handle, data.interviewId);
  if (!interview || !interview.confirmedAt || !interview.startsAt) {
    return { status: 'skipped', reason: 'not_confirmed' };
  }
  if (interview.startsAt.toISOString() !== data.startsAt) {
    return { status: 'skipped', reason: 'rescheduled' };
  }
  if (interview.startsAt.getTime() <= deps.now().getTime()) {
    return { status: 'skipped', reason: 'in_the_past' };
  }
  const marker = `${data.interviewId}:${data.offset}:${data.startsAt}`;
  if (await hasActivityWithDetail(handle, interview.userId, 'reminder_sent', 'marker', marker)) {
    return { status: 'skipped', reason: 'already_sent' };
  }

  const user = await getUserById(handle, interview.userId);
  const mailDeps = deps.mail(handle, interview.userId);
  const key = reminderDeliveryKey(data.interviewId, data.offset, data.startsAt);
  const logSent = (outgoingId: string) =>
    activity.logActivity(handle, {
      userId: interview.userId,
      applicationId: interview.applicationId,
      actor: 'agent',
      action: 'reminder_sent',
      detail: {
        interview_id: interview.id,
        offset_seconds: data.offset,
        marker,
        outgoing_id: outgoingId,
      },
    });

  // A crash after the send but before the activity entry: the receipt says it went out.
  const receipt = await mailDeps.store.findByKey(key);
  if (receipt?.state === 'sent') {
    await logSent(receipt.id);
    return { status: 'skipped', reason: 'already_sent' };
  }

  const label = (await listApplicationLabels(handle, [interview.applicationId])).get(
    interview.applicationId,
  );
  const mail = renderReminder({
    company: label?.companyName ?? 'the company',
    role: label?.jobTitle ?? 'the role',
    interviewer: await interviewerFor(handle, interview),
    startsAt: interview.startsAt,
    timezone: user.timezone,
    now: deps.now(),
    cardUrl: cardUrl(deps.webOrigin, interview.applicationId),
    prepUrl:
      interview.prepPlanStatus === 'ready' ? prepPlanUrl(deps.webOrigin, interview.id) : null,
  });
  const result = await sendEmailRecovering(mailDeps, {
    userId: interview.userId,
    kind: 'reminder',
    applicationId: interview.applicationId,
    to: user.email,
    deliveryKey: key,
    ...mail,
  });
  if (result.status === 'blocked') return { status: 'blocked', outgoingId: result.outgoingId };
  if (result.status === 'uncertain') throw new DeliveryUncertainError(key);
  await logSent(result.outgoingId);
  return { status: 'sent', outgoingId: result.outgoingId };
}

/** An earlier send under this delivery key has an unknown outcome; it is not repeated blindly. The job retries and reconciles. */
export class DeliveryUncertainError extends Error {
  readonly code = 'delivery_uncertain' as const;
  constructor(readonly deliveryKey: string) {
    super('an earlier send for this notification has an unknown outcome; not sending again');
    this.name = 'DeliveryUncertainError';
  }
}
