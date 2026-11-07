import type { PgBoss } from 'pg-boss';
import {
  activity,
  insertApplication,
  listApplicationJobKeys,
  listApplications,
  upsertJob,
  withUserLock,
  type TenantHandle,
} from '@wma/db';
import { dedupeKey, normalizeJobUrl } from '@wma/shared';
import {
  SUBMIT_APPLICATION_JOB,
  SUBMIT_QUEUE_OPTIONS,
  type SubmitApplicationJobData,
} from '../jobs/submit-application';
import type { Ranked } from './rank';

/** Where hand-off sends `submit-application` messages. Injected in tests. */
export interface SubmitQueue {
  /** Rejects when the message could not be queued; resolves when it is queued or already is. */
  enqueueSubmit(data: SubmitApplicationJobData): Promise<void>;
  /** True while a queued, retrying or active job exists for the application. */
  hasLiveJob(applicationId: string): Promise<boolean>;
}

const LIVE_STATES = new Set(['created', 'retry', 'active']);

/**
 * pg-boss producer; the singleton key is the application id. The queue is created with the same
 * options the consumer uses, so whichever side initializes it first leaves the same queue behind.
 */
export function bossSubmitQueue(boss: PgBoss): SubmitQueue {
  return {
    async enqueueSubmit(data) {
      await boss.createQueue(SUBMIT_APPLICATION_JOB, SUBMIT_QUEUE_OPTIONS);
      await boss.send(SUBMIT_APPLICATION_JOB, data, {
        ...SUBMIT_QUEUE_OPTIONS,
        singletonKey: data.applicationId,
      });
    },
    async hasLiveJob(applicationId) {
      if (!(await boss.getQueue(SUBMIT_APPLICATION_JOB))) return false;
      const jobs = await boss.findJobs(SUBMIT_APPLICATION_JOB, { key: applicationId });
      return jobs.some((j) => LIVE_STATES.has(j.state));
    },
  };
}

export interface HandOffResult {
  /** Application ids created by this hand-off, in rank order. */
  created: string[];
  /** Dedupe keys of selected postings that already had an application (another run won them). */
  conflicts: string[];
  /** Pending applications enqueued again: attempt-zero rows with no live job, and day-old retries. */
  requeued: string[];
  enqueueFailures: number;
}

/**
 * Hand-off is one transaction: upsert each job, insert a pending application linked to the run,
 * and write a single `handed_off` entry. Any failure rolls back every row of the run. The
 * transaction holds the user's advisory lock and re-checks existing applications under it, so two
 * runs for different dates cannot both claim one posting; a posting that lost is reported in
 * `conflicts` so the caller can clear its selection flag and count. Only after the commit are
 * messages enqueued, one per application, so a consumer never sees a row that may still roll back.
 */
export async function handOff(
  handle: TenantHandle,
  params: { userId: string; runId: string; runDate: string; selected: readonly Ranked[] },
  queue: SubmitQueue,
): Promise<HandOffResult> {
  const { userId, runId, runDate, selected } = params;
  const { created, conflicts } = await withUserLock(handle, userId, async (h) => {
    const taken = new Set(
      (await listApplicationJobKeys(h, userId)).map((k) =>
        dedupeKey({ ats: k.ats, atsJobId: k.atsJobId, url: k.url }),
      ),
    );
    const ids: string[] = [];
    const lost: string[] = [];
    for (const s of selected) {
      const c = s.candidate;
      const key = dedupeKey(c);
      if (taken.has(key)) {
        lost.push(key);
        continue;
      }
      const { job } = await upsertJob(h, {
        companyId: c.companyId,
        ats: c.ats,
        atsJobId: c.atsJobId,
        title: c.title,
        url: normalizeJobUrl(c.url),
        description: c.description,
        location: c.location,
        locationMode: s.judgment.location_mode,
        payMin: s.judgment.pay_min,
        payMax: s.judgment.pay_max,
        currency: s.judgment.currency,
        postedAt: c.postedAt ? new Date(c.postedAt) : null,
        raw: c.raw ?? null,
      });
      const { application, created: isNew } = await insertApplication(h, {
        userId,
        jobId: job.id,
        runId,
        status: 'pending',
        attemptCount: 0,
      });
      if (isNew) {
        ids.push(application.id);
        taken.add(key);
      } else {
        lost.push(key);
      }
    }
    await activity.logActivity(h, {
      userId,
      actor: 'agent',
      action: 'handed_off',
      detail: { run_id: runId, count: ids.length },
    });
    return { created: ids, conflicts: lost };
  });

  // Recovery of pending rows from earlier hand-offs. An attempt-zero row of ANY date whose job is
  // gone (crash after the commit, failed enqueue, failed job) is enqueued again: otherwise its
  // posting would be dropped as already-applied and never submitted. A row with one failed attempt
  // gets its single retry on a later day only, so a second run today cannot spend it.
  const pending = await listApplications(handle, userId, { status: ['pending'] });
  const requeued: string[] = [];
  for (const a of pending) {
    if (created.includes(a.id)) continue;
    const retryDue = a.attemptCount === 1 && a.createdAt.toISOString().slice(0, 10) < runDate;
    if (a.attemptCount === 0) {
      if (!(await queue.hasLiveJob(a.id))) requeued.push(a.id);
    } else if (retryDue) {
      requeued.push(a.id);
    }
  }

  let enqueueFailures = 0;
  for (const applicationId of [...created, ...requeued]) {
    try {
      await queue.enqueueSubmit({ tenantId: handle.tenantId, userId, applicationId });
    } catch {
      enqueueFailures++;
    }
  }
  if (enqueueFailures) {
    await activity.logActivity(handle, {
      userId,
      actor: 'agent',
      action: 'handoff_enqueue_failed',
      detail: { run_id: runId, count: enqueueFailures },
    });
  }
  return { created, conflicts, requeued, enqueueFailures };
}
