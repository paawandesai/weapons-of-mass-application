import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { guardedJob } from '../guarded';
import type { InboxDeps } from '../inbox/deps';
import { runFollowUp } from '../inbox/follow-up';

/** Enqueued by a successful submission (startAfter applied_at + 7 days); consumed by this job. */
export const FOLLOW_UP_JOB = 'follow-up';

export interface FollowUpData {
  tenantId: string;
  userId: string;
  applicationId: string;
}

/** Registers the follow-up consumer (rule 12). */
export async function registerFollowUp(
  boss: PgBoss,
  db: Db,
  options: { deps?: InboxDeps } = {},
): Promise<void> {
  let deps = options.deps;
  await boss.createQueue(FOLLOW_UP_JOB);
  await boss.work<FollowUpData>(FOLLOW_UP_JOB, async (jobs) => {
    for (const job of jobs) {
      const { tenantId, userId, applicationId } = job.data;
      const inbox = (deps ??= (await import('../inbox/wiring')).createInboxDeps(boss));
      const handle = db.forTenant(tenantId);
      await guardedJob(FOLLOW_UP_JOB, () => runFollowUp(handle, { userId, applicationId }, inbox))({
        handle,
        userId,
      });
    }
  });
}
