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
import { registerOutreach } from './jobs/outreach';
import { registerNegotiation } from './jobs/negotiation';
import { registerPrepPlan } from './jobs/prep-plan';
import { startPendingJobDispatcher } from './jobs/pending-jobs';
import { registerSimulatedRecruiter } from './jobs/simulated-recruiter';
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
  await registerOutreach(boss, db);
}

/** Wave 4 job registration (prep plan, negotiation, simulated recruiter). */
export async function registerWave4Jobs(boss: PgBoss, db: Db): Promise<void> {
  await registerPrepPlan(boss, db);
  await registerNegotiation(boss, db);
  await registerSimulatedRecruiter(boss, db);
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
  await registerWave4Jobs(boss, db);
  // Last, so every queue a pending row can name already exists.
  await startPendingJobDispatcher(boss, db);
}
