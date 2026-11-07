import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { markRevoked } from '@wma/google';
import { BOOK_INTERVIEW_JOB, BOOK_QUEUE_OPTIONS } from '@wma/shared';
import { guardedJob } from '../guarded';
import { createNotificationDeps } from '../notifications/deps';
import { scheduleReminders } from '../notifications/reminders';
import { isGoogleAuthError } from '../scheduling/auth';
import { bookInterview, type BookResult } from '../scheduling/book';
import { createSchedulingDeps } from '../scheduling/ports';
import type { SchedulingDeps } from '../scheduling/types';

export { BOOK_INTERVIEW_JOB, BOOK_QUEUE_OPTIONS };

export interface BookInterviewJobData {
  tenantId: string;
  userId: string;
  interviewId: string;
}

export type SchedulingDepsFactory = (
  handle: Parameters<typeof createSchedulingDeps>[0],
  userId: string,
) => SchedulingDeps;

/** Runs one booking job; the consumer calls this per job and tests call it with fake collaborators. */
export async function runBookInterview(
  db: Pick<Db, 'forTenant'>,
  data: BookInterviewJobData,
  makeDeps: SchedulingDepsFactory,
): Promise<{ ran: boolean; result?: BookResult }> {
  const handle = db.forTenant(data.tenantId);
  const run = guardedJob(BOOK_INTERVIEW_JOB, (ctx) =>
    bookInterview(
      ctx.handle,
      { userId: ctx.userId, interviewId: data.interviewId },
      makeDeps(ctx.handle, ctx.userId),
    ),
  );
  try {
    const out = await run({ handle, userId: data.userId });
    return out.ran ? { ran: true, result: out.result } : { ran: false };
  } catch (e) {
    if (isGoogleAuthError(e)) {
      // A revoked Google grant cannot be retried into working; the user is asked to reconnect.
      await markRevoked(handle, data.userId);
      return { ran: false };
    }
    throw e;
  }
}

/** Registers the book-interview consumer. */
export async function registerBookInterview(
  boss: PgBoss,
  db: Db,
  makeDeps?: SchedulingDepsFactory,
): Promise<void> {
  await boss.createQueue(BOOK_INTERVIEW_JOB, BOOK_QUEUE_OPTIONS);
  const notifications = createNotificationDeps(boss);
  const factory: SchedulingDepsFactory =
    makeDeps ??
    ((handle, userId) => ({
      ...createSchedulingDeps(handle, userId, async (h, interviewId) => {
        await scheduleReminders(h, interviewId, notifications);
      }),
    }));
  await boss.work<BookInterviewJobData>(BOOK_INTERVIEW_JOB, async (jobs) => {
    for (const job of jobs) {
      try {
        await runBookInterview(db, job.data, factory);
      } catch (e) {
        console.error('book-interview failed:', e instanceof Error ? e.name : 'error');
        throw e;
      }
    }
  });
}
