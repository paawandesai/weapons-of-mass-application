import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { SCHEDULE_REMINDERS_JOB, SCHEDULE_REMINDERS_QUEUE_OPTIONS } from '@wma/shared';
import { guardedJob } from '../guarded';
import { REMINDER_JOB } from '../notifications/constants';
import { createNotificationDeps, type NotificationDeps } from '../notifications/deps';
import {
  runReminder,
  scheduleReminders,
  type ReminderJobData,
  type ScheduleRemindersJobData,
} from '../notifications/reminders';

export { REMINDER_JOB };

/**
 * Registers the reminder consumer. Reminders themselves are enqueued by `scheduleReminders` when
 * a slot is confirmed; the handler re-checks the interview, so a cancelled or rescheduled one
 * sends nothing.
 */
export async function registerReminders(
  boss: PgBoss,
  db: Db,
  deps: NotificationDeps = createNotificationDeps(boss),
): Promise<void> {
  await boss.createQueue(REMINDER_JOB, { policy: 'exclusive' });
  await boss.createQueue(SCHEDULE_REMINDERS_JOB, SCHEDULE_REMINDERS_QUEUE_OPTIONS);
  // The API enqueues this when the user confirms a slot, and the scheduler enqueues it again
  // (with a delay) when an old reminder was still running; both just (re)schedule.
  await boss.work<ScheduleRemindersJobData>(SCHEDULE_REMINDERS_JOB, async (jobs) => {
    for (const job of jobs) {
      const handle = db.forTenant(job.data.tenantId);
      const run = guardedJob(SCHEDULE_REMINDERS_JOB, (ctx) =>
        scheduleReminders(ctx.handle, job.data.interviewId, deps, job.data.attempt ?? 0),
      );
      await run({ handle, userId: job.data.userId });
    }
  });
  await boss.work<ReminderJobData>(REMINDER_JOB, async (jobs) => {
    for (const job of jobs) {
      const handle = db.forTenant(job.data.tenantId);
      const run = guardedJob(REMINDER_JOB, (ctx) => runReminder(ctx.handle, job.data, deps));
      await run({ handle, userId: job.data.userId });
    }
  });
}
