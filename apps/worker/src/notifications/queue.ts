import type { PgBoss } from 'pg-boss';

export interface QueueSendOptions {
  singletonKey: string;
  startAfter?: Date;
  retryLimit?: number;
  retryDelay?: number;
}

/** The slice of the job queue the notifications use; tests supply a fake with a clock. */
export interface NotificationQueue {
  /** Returns the job id, or null when a job with this singleton key is already queued. */
  send(job: string, data: object, opts: QueueSendOptions): Promise<string | null>;
  /** Cancels queued (not yet started) jobs with this singleton key; returns how many. */
  cancelByKey(job: string, singletonKey: string): Promise<number>;
}

export function bossNotificationQueue(boss: PgBoss): NotificationQueue {
  return {
    async send(job, data, opts) {
      return boss.send(job, data, {
        singletonKey: opts.singletonKey,
        ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
        retryLimit: opts.retryLimit ?? 0,
        ...(opts.retryDelay !== undefined ? { retryDelay: opts.retryDelay } : {}),
      });
    },
    async cancelByKey(job, singletonKey) {
      const found = await boss.findJobs(job, { key: singletonKey, queued: true });
      if (found.length === 0) return 0;
      await boss.cancel(
        job,
        found.map((j) => j.id),
      );
      return found.length;
    },
  };
}
