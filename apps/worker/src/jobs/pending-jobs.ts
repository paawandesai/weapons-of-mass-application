import type { PgBoss, SendOptions } from 'pg-boss';
import {
  listUndispatchedJobs,
  markJobsDispatched,
  type Db,
  type PendingJobRow,
  type TenantHandle,
} from '@wma/db';
import {
  NEGOTIATION_JOB,
  NEGOTIATION_QUEUE_OPTIONS,
  PREP_PLAN_JOB,
  PREP_PLAN_QUEUE_OPTIONS,
} from '@wma/shared';
import { MAIL_SYNC_JOB, mailSyncKey } from './mail-sync';
import { repairPendingPrepPlans } from './prep-plan';

/** How often the reconciler looks for undispatched rows (it also runs once at worker start). */
export const PENDING_JOBS_POLL_MS = 30_000;

/**
 * Follow-on work is written to `pending_jobs` inside the transaction of the change that needs
 * it. A row's `kind` is the queue name and its `payload` is the job data, so any producer can add
 * a kind without touching this file. The reconciler sends each row to its queue and stamps
 * `dispatched_at`; a crash between the send and the stamp sends the row again, which the queue's
 * singleton key (the row's `dedupeKey`, or the kind's own key below) collapses.
 */
const retryOf = (o: { retryLimit: number; retryDelay: number; retryBackoff: boolean }) => ({
  retryLimit: o.retryLimit,
  retryDelay: o.retryDelay,
  retryBackoff: o.retryBackoff,
});

const SEND_OPTIONS: Record<string, (row: PendingJobRow) => SendOptions> = {
  [PREP_PLAN_JOB]: (row) => ({ singletonKey: row.dedupeKey, ...retryOf(PREP_PLAN_QUEUE_OPTIONS) }),
  [NEGOTIATION_JOB]: (row) => ({
    singletonKey: row.dedupeKey,
    ...retryOf(NEGOTIATION_QUEUE_OPTIONS),
  }),
  [MAIL_SYNC_JOB]: (row) => ({
    singletonKey: mailSyncKey(row.userId),
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
  }),
};

const sendOptionsFor = (row: PendingJobRow): SendOptions =>
  SEND_OPTIONS[row.kind]?.(row) ?? { singletonKey: row.dedupeKey, retryLimit: 3, retryDelay: 60 };

/** Sends the tenant's undispatched rows; returns how many were sent. A failing row stays pending. */
export async function dispatchPendingJobs(
  handle: TenantHandle,
  boss: Pick<PgBoss, 'send'>,
): Promise<number> {
  const rows = await listUndispatchedJobs(handle);
  let sent = 0;
  for (const row of rows) {
    try {
      const id = await boss.send(row.kind, row.payload as object, sendOptionsFor(row));
      // null: an identical job is queued or running. For a mail sync that run may have listed
      // the mailbox before this message arrived, so the row waits for the next pass; other kinds
      // are covered by the job already in the queue.
      if (id === null && row.kind === MAIL_SYNC_JOB) continue;
      await markJobsDispatched(handle, [row.id]);
      sent++;
    } catch (e) {
      console.error(
        'pending job dispatch failed:',
        row.kind,
        e instanceof Error ? e.name : 'error',
      );
    }
  }
  return sent;
}

/**
 * One pass: first re-record prep plans stuck pending without owed work (per approved user), then
 * send every tenant's undispatched rows.
 */
export async function dispatchAllPendingJobs(
  db: Pick<Db, 'forTenant' | 'tenantsWithPendingJobs' | 'digestRoster'>,
  boss: Pick<PgBoss, 'send'>,
): Promise<number> {
  for (const u of await db.digestRoster()) {
    try {
      await repairPendingPrepPlans(db.forTenant(u.tenantId), u.userId);
    } catch (e) {
      console.error('prep plan repair failed:', e instanceof Error ? e.name : 'error');
    }
  }
  let sent = 0;
  for (const tenantId of await db.tenantsWithPendingJobs()) {
    sent += await dispatchPendingJobs(db.forTenant(tenantId), boss);
  }
  return sent;
}

/** Dispatches once now and every 30 s after. Call after every consuming queue is registered. */
export async function startPendingJobDispatcher(
  boss: PgBoss,
  db: Db,
  options: { pollMs?: number } = {},
): Promise<void> {
  const pass = () =>
    dispatchAllPendingJobs(db, boss).catch((e: unknown) =>
      console.error('pending job dispatcher failed:', e instanceof Error ? e.name : 'error'),
    );
  await pass();
  const timer = setInterval(() => void pass(), options.pollMs ?? PENDING_JOBS_POLL_MS);
  timer.unref();
}
