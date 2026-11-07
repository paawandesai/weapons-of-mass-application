import type { PgBoss } from 'pg-boss';
import { listFollowUpsOwed, markFollowUpEnqueued, type Db, type TenantHandle } from '@wma/db';
import { FOLLOW_UP_JOB, followUpDelayMs } from './constants';
import type { FollowUpJobData, FollowUpQueue } from './deps';

/**
 * Enqueues the follow-up job for an applied application. The job id is the application id, so a
 * second enqueue for the same application inserts nothing. The consumer belongs to the inbox
 * wave; the job waits unclaimed until then.
 */
export function createFollowUpQueue(boss: PgBoss): FollowUpQueue {
  return {
    async enqueueFollowUp(data, startAfter) {
      await boss.createQueue(FOLLOW_UP_JOB);
      await boss.send(FOLLOW_UP_JOB, data, {
        id: data.applicationId,
        singletonKey: data.applicationId,
        startAfter,
        retryLimit: 0,
      });
    },
  };
}

export const followUpStart = (appliedAt: Date) => new Date(appliedAt.getTime() + followUpDelayMs());

/**
 * Queues the follow-up for one applied application, then records that it is queued. A crash
 * between the two leaves the row owed; the reconciliation pass enqueues again, which the
 * singleton key makes a no-op.
 */
export async function scheduleFollowUp(
  handle: TenantHandle,
  queue: FollowUpQueue,
  data: FollowUpJobData,
  appliedAt: Date,
): Promise<void> {
  await queue.enqueueFollowUp(data, followUpStart(appliedAt));
  await markFollowUpEnqueued(handle, data.applicationId, new Date());
}

export interface FollowUpReconcileHandle {
  db: Pick<Db, 'pool' | 'forTenant'>;
  queue: FollowUpQueue;
}

/**
 * Enqueues the follow-up for every applied application that has none recorded (a crash after
 * `applied` committed, or a failed enqueue). Idempotent; returns how many rows were repaired.
 * Failures on one row do not stop the others.
 */
export async function reconcileFollowUps(handle: FollowUpReconcileHandle): Promise<number> {
  const owed = await listFollowUpsOwed(handle.db);
  let repaired = 0;
  for (const row of owed) {
    try {
      await scheduleFollowUp(
        handle.db.forTenant(row.tenantId),
        handle.queue,
        { tenantId: row.tenantId, userId: row.userId, applicationId: row.applicationId },
        row.appliedAt,
      );
      repaired++;
    } catch {
      // stays owed; the next pass tries again
    }
  }
  return repaired;
}
