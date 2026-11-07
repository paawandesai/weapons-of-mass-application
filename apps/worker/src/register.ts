import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import {
  executeProfileBuild,
  PROFILE_BUILD_JOB,
  type ProfileBuildJobData,
} from './jobs/profile-build';
import { registerDailyRun } from './jobs/daily-run';
import { registerSubmitApplication } from './jobs/submit-application';
import type { BuildDeps } from './profile/build';

/** Wave 2 job registration; each file owns its own handler. */
export async function registerWave2Jobs(boss: PgBoss, db: Db): Promise<void> {
  await registerDailyRun(boss, db);
  await registerSubmitApplication(boss, db);
}

/** Registers every job handler. New jobs other than profile.build go through guardedJob. */
export async function registerJobs(boss: PgBoss, db: Db, deps: BuildDeps): Promise<void> {
  await boss.createQueue(PROFILE_BUILD_JOB);
  await boss.work<ProfileBuildJobData>(PROFILE_BUILD_JOB, async (jobs) => {
    for (const job of jobs) {
      const handle = db.forTenant(job.data.tenantId);
      await executeProfileBuild(handle, job.data, deps);
    }
  });
  await registerWave2Jobs(boss, db);
}
