import { createHash } from 'node:crypto';
import {
  activity,
  confirmSlotByTokenHash,
  getApplication,
  getCompany,
  getInterview,
  getInterviewSlot,
  getJob,
  getSlotByTokenHash,
  getUserById,
  type Db,
  type InterviewRow,
  type InterviewSlotRow,
  type TenantHandle,
} from '@wma/db';
import {
  BOOK_INTERVIEW_JOB,
  BOOK_QUEUE_OPTIONS,
  SCHEDULE_REMINDERS_JOB,
  SCHEDULE_REMINDERS_QUEUE_OPTIONS,
} from '@wma/shared';
import { getBoss } from './queue';

export { BOOK_INTERVIEW_JOB, BOOK_QUEUE_OPTIONS };
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface BookJobData {
  tenantId: string;
  userId: string;
  interviewId: string;
}

/** Hands a confirmed interview to the worker. Injected in tests. */
export interface BookingQueue {
  enqueueBookInterview(data: BookJobData, slotId: string): Promise<void>;
  /**
   * Schedules the interview's reminders from the confirmation itself, so they exist even when the
   * recruiter reply is blocked or late. The worker's booking job schedules them again as a backup.
   */
  enqueueScheduleReminders(data: BookJobData, slotId: string): Promise<void>;
}

export const pgBossBookingQueue: BookingQueue = {
  async enqueueBookInterview(data, slotId) {
    const b = await getBoss();
    // The same exclusive policy as the worker's queue, whichever side creates it first.
    await b.createQueue(BOOK_INTERVIEW_JOB, BOOK_QUEUE_OPTIONS);
    await b.send(BOOK_INTERVIEW_JOB, data, { singletonKey: `${data.interviewId}:${slotId}` });
  },
  async enqueueScheduleReminders(data, slotId) {
    const b = await getBoss();
    await b.createQueue(SCHEDULE_REMINDERS_JOB, SCHEDULE_REMINDERS_QUEUE_OPTIONS);
    await b.send(SCHEDULE_REMINDERS_JOB, data, { singletonKey: `${data.interviewId}:${slotId}` });
  },
};

export interface SlotDetails {
  company: string;
  role: string;
  when: string;
}

/** The short zone name ("PST") and the numeric offset ("GMT-8") of an instant in a zone. */
const zoneOf = (d: Date, zone: string) => {
  const get = (style: 'short' | 'shortOffset') =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', timeZoneName: style })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? zone;
  return { name: get('short'), offset: get('shortOffset') };
};

/**
 * "Thursday, November 12, 2026, 10:00 AM to 11:00 AM PST". A slot that crosses a DST transition
 * shows the zone and offset on both ends, so the instant the user confirms is never ambiguous.
 */
export const formatWhen = (slot: { startsAt: Date; endsAt: Date }, zone: string) => {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(slot.startsAt);
  const time = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' })
      .format(d)
      .replace(/\u202f/g, ' ');
  const a = zoneOf(slot.startsAt, zone);
  const b = zoneOf(slot.endsAt, zone);
  if (a.offset === b.offset)
    return `${date}, ${time(slot.startsAt)} to ${time(slot.endsAt)} ${b.name}`;
  return `${date}, ${time(slot.startsAt)} ${a.name} (${a.offset}) to ${time(slot.endsAt)} ${b.name} (${b.offset})`;
};

export interface FoundSlot {
  handle: TenantHandle;
  slot: InterviewSlotRow;
  open: boolean;
  interview: InterviewRow;
  details: SlotDetails;
  /** What a closed link shows: where the interview stands now. */
  state: string;
}

/** Read-only lookup behind a link; null for an unknown or malformed token. */
export async function findSlot(db: Db, token: string, now: Date): Promise<FoundSlot | null> {
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = hashToken(token);
  const found = await db.resolveSlotToken(tokenHash);
  if (!found) return null;
  const handle = db.forTenant(found.tenantId);
  const view = await getSlotByTokenHash(handle, tokenHash);
  if (!view) return null;
  const interview = await getInterview(handle, view.interviewId);
  if (!interview) return null;
  const [user, application] = await Promise.all([
    getUserById(handle, interview.userId),
    getApplication(handle, interview.applicationId),
  ]);
  const job = application ? await getJob(handle, application.jobId) : null;
  const company = job?.companyId ? await getCompany(handle, job.companyId) : null;
  const details: SlotDetails = {
    company: company?.name ?? 'the company',
    role: job?.title ?? 'the role',
    when: formatWhen(view, user.timezone),
  };
  let state = 'This request is no longer open.';
  if (interview.confirmedSlotId) {
    const chosen = await getInterviewSlot(handle, interview.confirmedSlotId);
    state = chosen
      ? `You already confirmed ${formatWhen(chosen, user.timezone)}.`
      : 'You already confirmed a time for this interview.';
  } else if (view.expiresAt <= now) {
    state = 'These times expired. Ask for new times from your inbox.';
  } else if (view.startsAt <= now) {
    state = 'That time has already started. Ask for new times from your inbox.';
  } else if (view.invalidatedAt) {
    state = 'New times replaced these ones. Check your inbox for the latest request.';
  }
  const { open, ...slot } = view;
  return { handle, slot, open, interview, details, state };
}

export type ConfirmResult = { ok: true; details: SlotDetails } | { ok: false; state: string };

/**
 * Confirms the slot behind a link: one transaction in the repo (token valid, unexpired, interview
 * not yet confirmed; siblings invalidated), then the booking job is queued. Only the first use
 * of a link writes anything.
 */
export async function confirmSlot(
  db: Db,
  token: string,
  queue: BookingQueue,
  now: Date,
): Promise<ConfirmResult> {
  const found = await findSlot(db, token, now);
  const closed = (state = found?.state ?? 'This request is no longer open.'): ConfirmResult => ({
    ok: false,
    state,
  });
  if (!found) return closed();
  const result = await confirmSlotByTokenHash(found.handle, hashToken(token));
  if (!result.ok) {
    // Re-read: the state may have changed between the lookup and the attempt.
    const again = await findSlot(db, token, now);
    return closed(again?.state);
  }
  const { handle, interview, slot } = found;
  await activity.logActivity(handle, {
    userId: interview.userId,
    applicationId: interview.applicationId,
    actor: 'user',
    action: 'slot_confirmed',
    detail: {
      interview_id: interview.id,
      slot_id: slot.id,
      starts_at: slot.startsAt.toISOString(),
    },
  });
  const job = { tenantId: handle.tenantId, userId: interview.userId, interviewId: interview.id };
  // Each hand-off is independent: a lost reminder enqueue never costs the booking, and the
  // worker's repair pass queues either again. Reminders go first so a slow booking cannot delay them.
  const failures: string[] = [];
  try {
    await queue.enqueueScheduleReminders(job, slot.id);
  } catch {
    failures.push('reminders');
  }
  try {
    await queue.enqueueBookInterview(job, slot.id);
  } catch {
    failures.push('booking');
  }
  if (failures.length > 0) {
    await activity.logActivity(handle, {
      userId: interview.userId,
      applicationId: interview.applicationId,
      actor: 'agent',
      action: 'book_enqueue_failed',
      detail: { interview_id: interview.id, failed: failures },
    });
  }
  return { ok: true, details: found.details };
}
