import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { guardedJob } from '../guarded';
import { DIGEST_JOB, DIGEST_TICK_JOB } from '../notifications/constants';
import { createNotificationDeps, type NotificationDeps } from '../notifications/deps';
import { enqueueScheduledDigests, runDigest, type DigestJobData } from '../notifications/digest';

export { DIGEST_JOB, DIGEST_TICK_JOB };

export interface DigestRegistration {
  deps?: NotificationDeps;
  /** Skip the hourly schedule (tests). */
  schedule?: boolean;
}

/**
 * Registers the digest consumer and the hourly tick that enqueues one digest per user at their
 * digest hour in their time zone.
 */
export async function registerDigest(
  boss: PgBoss,
  db: Db,
  options: DigestRegistration = {},
): Promise<void> {
  const deps = options.deps ?? createNotificationDeps(boss);
  await boss.createQueue(DIGEST_JOB, { policy: 'exclusive' });
  await boss.createQueue(DIGEST_TICK_JOB);
  await boss.work<DigestJobData>(DIGEST_JOB, async (jobs) => {
    for (const job of jobs) {
      const handle = db.forTenant(job.data.tenantId);
      const run = guardedJob(DIGEST_JOB, (ctx) =>
        runDigest(ctx.handle, { userId: ctx.userId, date: job.data.date }, deps),
      );
      await run({ handle, userId: job.data.userId });
    }
  });
  await boss.work(DIGEST_TICK_JOB, async () => {
    await enqueueScheduledDigests(deps.queue, db, deps.now());
  });
  if (options.schedule !== false) await boss.schedule(DIGEST_TICK_JOB, '0 * * * *');
}
