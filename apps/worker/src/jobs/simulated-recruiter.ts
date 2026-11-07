import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { guardedJob } from '../guarded';
import { recruiterDelayMs, runSimulatedRecruiter, type RecruiterResult } from '../demo/recruiter';
import { dispatchPendingJobs } from './pending-jobs';

export const SIMULATED_RECRUITER_JOB = 'simulated-recruiter';
/** How often demo mode asks for a pass. */
export const SIMULATED_RECRUITER_POLL_MS = 30_000;

export interface SimulatedRecruiterJobData {
  /** Skip the configured delay (the on-demand sync). */
  immediate?: boolean;
}

export interface SimulatedRecruiterRegistration {
  /** Poll every 30 s. Default: on when `DEMO_FORMS_PORT` is set, i.e. in demo mode. */
  poll?: boolean;
  delayMs?: number;
}

/** One pass for the demo tenant's user, if exactly one tenant is flagged. */
export async function runSimulatedRecruiterTick(
  boss: Pick<PgBoss, 'send'>,
  db: Pick<Db, 'demoUser' | 'forTenant'>,
  data: SimulatedRecruiterJobData = {},
  delayMs: number = recruiterDelayMs(),
): Promise<RecruiterResult | null> {
  const demo = await db.demoUser();
  if (!demo) return null;
  const handle = db.forTenant(demo.tenantId);
  const out = await guardedJob(SIMULATED_RECRUITER_JOB, () =>
    runSimulatedRecruiter(handle, demo.userId, {
      delayMs,
      immediate: data.immediate === true,
    }),
  )({ handle, userId: demo.userId });
  // The delivery wrote a `mail-sync` row with the message; sending it is the only step left, and
  // it is retried on every tick until it succeeds, whether or not this pass delivered anything.
  await dispatchPendingJobs(handle, boss);
  if (!out.ran) return null;
  return out.result;
}

/**
 * Registers the simulated-recruiter consumer. It is driven by polling, not by a hook in the
 * submission job: in demo mode a timer enqueues a pass every 30 s (one queued at a time), and each
 * pass looks at the demo tenant's applied applications and recruiter replies. That covers both
 * triggers (the `applied` transition and the reply watcher) with one idempotent function, and
 * leaves the submission job untouched. Real tenants never reach it: the pass is a no-op unless
 * `tenants.demo` is set.
 */
export async function registerSimulatedRecruiter(
  boss: PgBoss,
  db: Db,
  options: SimulatedRecruiterRegistration = {},
): Promise<void> {
  const delayMs = options.delayMs ?? recruiterDelayMs();
  await boss.createQueue(SIMULATED_RECRUITER_JOB);
  await boss.work<SimulatedRecruiterJobData>(SIMULATED_RECRUITER_JOB, async (jobs) => {
    for (const job of jobs) {
      try {
        await runSimulatedRecruiterTick(boss, db, job.data ?? {}, delayMs);
      } catch (e) {
        console.error('simulated-recruiter failed:', e instanceof Error ? e.name : 'error');
        throw e;
      }
    }
  });
  const poll = options.poll ?? Boolean(process.env.DEMO_FORMS_PORT);
  if (poll) {
    const timer = setInterval(() => {
      boss
        .send(
          SIMULATED_RECRUITER_JOB,
          {},
          { singletonSeconds: SIMULATED_RECRUITER_POLL_MS / 1000 - 5 },
        )
        .catch((e: unknown) =>
          console.error('simulated-recruiter poll failed:', e instanceof Error ? e.name : 'error'),
        );
    }, SIMULATED_RECRUITER_POLL_MS);
    timer.unref();
  }
}
