import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { guardedJob } from '../guarded';
import type { InboxDeps } from '../inbox/deps';
import { runMailSync } from '../inbox/sync';

export const MAIL_SYNC_JOB = 'mail-sync';
/** Hourly: enqueues one mail-sync per approved user. */
export const MAIL_SYNC_TICK_JOB = 'mail-sync-tick';

export interface MailSyncJobData {
  tenantId: string;
  userId: string;
}

/** One sync per user at a time: the id of the queued or running job is the user's. */
export const mailSyncKey = (userId: string) => `mail-sync:${userId}`;

export interface MailSyncRoster {
  users(): Promise<Array<{ tenantId: string; userId: string }>>;
}

export const dbMailSyncRoster = (db: Pick<Db, 'digestRoster'>): MailSyncRoster => ({
  users: async () =>
    (await db.digestRoster()).map(({ tenantId, userId }) => ({ tenantId, userId })),
});

/** Scheduler tick: one mail-sync per approved user; a user whose sync is still queued or running is skipped. */
export async function enqueueMailSyncs(
  boss: Pick<PgBoss, 'send'>,
  roster: MailSyncRoster,
): Promise<{ enqueued: number; duplicates: number }> {
  let enqueued = 0;
  let duplicates = 0;
  for (const u of await roster.users()) {
    const id = await boss.send(MAIL_SYNC_JOB, u satisfies MailSyncJobData, {
      singletonKey: mailSyncKey(u.userId),
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
    });
    if (id) enqueued++;
    else duplicates++;
  }
  return { enqueued, duplicates };
}

export interface MailSyncRegistration {
  deps?: InboxDeps;
  roster?: MailSyncRoster;
  /** Skip the cron schedule (tests). */
  schedule?: boolean;
}

/** Registers the mail-sync worker and the hourly tick that enqueues it per approved user. */
export async function registerMailSync(
  boss: PgBoss,
  db: Db,
  options: MailSyncRegistration = {},
): Promise<void> {
  let deps = options.deps;
  const getDeps = async () => (deps ??= (await import('../inbox/wiring')).createInboxDeps(boss));
  const roster = options.roster ?? dbMailSyncRoster(db);
  await boss.createQueue(MAIL_SYNC_JOB, { policy: 'exclusive' });
  await boss.createQueue(MAIL_SYNC_TICK_JOB);
  await boss.work<MailSyncJobData>(MAIL_SYNC_JOB, async (jobs) => {
    for (const job of jobs) {
      const { tenantId, userId } = job.data;
      const inbox = await getDeps();
      await guardedJob(MAIL_SYNC_JOB, () => runMailSync(db.forTenant(tenantId), userId, inbox))({
        handle: db.forTenant(tenantId),
        userId,
      });
    }
  });
  await boss.work(MAIL_SYNC_TICK_JOB, async () => {
    await enqueueMailSyncs(boss, roster);
  });
  if (options.schedule !== false) await boss.schedule(MAIL_SYNC_TICK_JOB, '7 * * * *');
}
