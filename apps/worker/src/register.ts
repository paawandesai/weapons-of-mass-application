import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import {
  executeProfileBuild,
  PROFILE_BUILD_JOB,
  type ProfileBuildJobData,
} from './jobs/profile-build';
import { registerDailyRun } from './jobs/daily-run';
import { registerBookInterview } from './jobs/book-interview';
import { registerDigest } from './jobs/digest';
import { registerFollowUp } from './jobs/follow-up';
import { registerMailSync } from './jobs/mail-sync';
import { registerReminders } from './jobs/reminders';
import { registerSubmitApplication } from './jobs/submit-application';
import type { BuildDeps } from './profile/build';

/** Wave 2 job registration; each file owns its own handler. */
export async function registerWave2Jobs(boss: PgBoss, db: Db): Promise<void> {
  await registerDailyRun(boss, db);
  await registerSubmitApplication(boss, db);
}

/** Wave 3 job registration (inbox, scheduling, follow-ups, reminders, digest). */
export async function registerWave3Jobs(boss: PgBoss, db: Db): Promise<void> {
  await registerMailSync(boss, db);
  await registerBookInterview(boss, db);
  await registerFollowUp(boss, db);
  await registerReminders(boss, db);
  await registerDigest(boss, db);
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
  await registerWave3Jobs(boss, db);
}
