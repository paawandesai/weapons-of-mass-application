import { PgBoss } from 'pg-boss';
import { DEFAULT_DATABASE_URL } from '@wma/db';

export const PROFILE_BUILD_JOB = 'profile.build';

export interface ProfileBuildJobData {
  tenantId: string;
  userId: string;
  buildId: string;
}

/** pg-boss job states (as stored); `null` from jobState means the job is unknown or already purged. */
export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

/** Hands a profile build to the worker. Injected in tests. */
export interface BuildQueue {
  enqueueProfileBuild(data: ProfileBuildJobData): Promise<void>;
  /** State of the job enqueued for this build (the job id is the build id), or null. */
  jobState(buildId: string): Promise<JobState | null>;
}

let boss: Promise<PgBoss> | null = null;

/** A producer-only pg-boss client, started on first use (the worker owns scheduling/maintenance). */
export function getBoss(): Promise<PgBoss> {
  boss ??= (async () => {
    const b = new PgBoss({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      supervise: false,
      schedule: false,
    });
    b.on('error', (err) => console.error('pg-boss error', err));
    await b.start();
    await b.createQueue(PROFILE_BUILD_JOB);
    return b;
  })();
  boss.catch(() => {
    boss = null;
  });
  return boss;
}

export const pgBossQueue: BuildQueue = {
  async enqueueProfileBuild(data) {
    const b = await getBoss();
    // The job id is the build id so the build's job can be looked up later.
    await b.send(PROFILE_BUILD_JOB, data, {
      id: data.buildId,
      retryLimit: 0,
      singletonKey: data.buildId,
    });
  },
  async jobState(buildId) {
    const b = await getBoss();
    const job = await b.getJobById(PROFILE_BUILD_JOB, buildId);
    return (job?.state as JobState | undefined) ?? null;
  },
};
