import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import {
  FOLLOW_UP_JOB,
  SUBMIT_APPLICATION_JOB,
  SUBMIT_CONCURRENCY,
  SUBMIT_QUEUE_OPTIONS,
} from '../submission/constants';
import type { SubmissionDeps } from '../submission/deps';
import { createFollowUpQueue, reconcileFollowUps } from '../submission/followup';
import { createSubmissionRunner, type SubmissionJobData } from '../submission/job';

export { FOLLOW_UP_JOB, SUBMIT_APPLICATION_JOB, SUBMIT_QUEUE_OPTIONS, reconcileFollowUps };
const FOLLOW_UP_RECONCILE_JOB = 'follow-up-reconcile';
export type SubmitApplicationJobData = SubmissionJobData;

/**
 * Registers the submit-application consumer: two attempts at a time per process, one browser
 * per process and one context per application. Production dependencies are built on the first
 * job, so registering needs no API key or browser. A failure inside one application is
 * recorded on its row and never reaches pg-boss or ends the process; a failure with no recorded
 * outcome (database outage, profile load) is rethrown so pg-boss retries the job.
 */
export async function registerSubmitApplication(
  boss: PgBoss,
  db: Db,
  deps?: SubmissionDeps,
): Promise<void> {
  await boss.createQueue(SUBMIT_APPLICATION_JOB, SUBMIT_QUEUE_OPTIONS);
  await boss.createQueue(FOLLOW_UP_JOB);
  let runner: ReturnType<typeof createSubmissionRunner> | null = null;
  const getRunner = async () => {
    if (!runner) {
      const resolved = deps ?? (await import('../submission/wiring')).createSubmissionDeps(boss);
      runner = createSubmissionRunner(resolved, db, { concurrency: SUBMIT_CONCURRENCY });
    }
    return runner;
  };
  await boss.work<SubmitApplicationJobData>(
    SUBMIT_APPLICATION_JOB,
    { localConcurrency: SUBMIT_CONCURRENCY, batchSize: 1 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          try {
            await (await getRunner()).run(job.data);
          } catch (e) {
            console.error('submit-application failed:', e instanceof Error ? e.name : 'error');
            throw e;
          }
        }),
      );
    },
  );

  // Applied applications whose follow-up was never queued: repaired now and then hourly.
  const queue = createFollowUpQueue(boss);
  const reconcile = async () => {
    try {
      await reconcileFollowUps({ db, queue });
    } catch (e) {
      console.error('follow-up reconcile failed:', e instanceof Error ? e.name : 'error');
    }
  };
  await boss.createQueue(FOLLOW_UP_RECONCILE_JOB);
  await boss.work(FOLLOW_UP_RECONCILE_JOB, async () => {
    await reconcile();
  });
  await boss.schedule(FOLLOW_UP_RECONCILE_JOB, '17 * * * *');
  await reconcile();
}
