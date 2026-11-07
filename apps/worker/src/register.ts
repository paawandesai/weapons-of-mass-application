import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import {
  executeProfileBuild,
  PROFILE_BUILD_JOB,
  type ProfileBuildJobData,
} from './jobs/profile-build';
import type { BuildDeps } from './profile/build';

/** Registers every job handler. New jobs other than profile.build go through guardedJob. */
export async function registerJobs(boss: PgBoss, db: Db, deps: BuildDeps): Promise<void> {
  await boss.createQueue(PROFILE_BUILD_JOB);
  await boss.work<ProfileBuildJobData>(PROFILE_BUILD_JOB, async (jobs) => {
    for (const job of jobs) {
      const handle = db.forTenant(job.data.tenantId);
      await executeProfileBuild(handle, job.data, deps);
    }
  });
}
