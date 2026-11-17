import type { PgBoss } from 'pg-boss';
import {
  activity,
  findJob,
  getRun,
  insertApplication,
  listApplicationJobKeys,
  listApplications,
  listCompaniesByIds,
  listJobsByIds,
  listRunCandidates,
  selectRunCandidate,
  upsertJob,
  withUserLock,
  type TenantHandle,
} from '@wma/db';
import { dedupeKey, Judgment, normalizeJobUrl, parseAtsJobUrl } from '@wma/shared';
// Values from the submission constants (not the job module) so the submit job can import this file.
import { SUBMIT_APPLICATION_JOB, SUBMIT_QUEUE_OPTIONS } from '../submission/constants';
import type { SubmitApplicationJobData } from '../jobs/submit-application';
import { companyKey, type Ranked } from './rank';

export interface EnqueueOptions {
  /** Start no sooner than this many seconds from now (a same-day retry). */
  startAfterSeconds?: number;
}

/** Where hand-off sends `submit-application` messages. Injected in tests. */
export interface SubmitQueue {
  /** Rejects when the message could not be queued; resolves when it is queued or already is. */
  enqueueSubmit(data: SubmitApplicationJobData, opts?: EnqueueOptions): Promise<void>;
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
    async enqueueSubmit(data, opts) {
      await boss.createQueue(SUBMIT_APPLICATION_JOB, SUBMIT_QUEUE_OPTIONS);
      await boss.send(SUBMIT_APPLICATION_JOB, data, {
        ...SUBMIT_QUEUE_OPTIONS,
        singletonKey: data.applicationId,
        ...(opts?.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
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
  params: {
    userId: string;
    runId: string;
    runDate: string;
    selected: readonly Ranked[];
    /** Re-enqueue pending rows of earlier hand-offs (default true; once per run is enough). */
    recover?: boolean;
  },
  queue: SubmitQueue,
): Promise<HandOffResult> {
  const { userId, runId, runDate, selected, recover = true } = params;
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
  const pending = recover ? await listApplications(handle, userId, { status: ['pending'] }) : [];
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

/**
 * Writes the job rows of approved postings a run did not select (over target or over the company
 * cap) without applications, so a later backfill has the full posting (description, location,
 * pay) to apply with. A job row alone does not count as applied.
 */
export async function stashReserve(
  handle: TenantHandle,
  reserve: readonly Ranked[],
): Promise<void> {
  for (const s of reserve) {
    const c = s.candidate;
    await upsertJob(handle, {
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
  }
}

/** Keys a company is known by: its normalised name, and its board slug when the URL has one. */
export function companyKeysFor(name: string | null | undefined, url: string | null | undefined) {
  const keys: string[] = [];
  if (name && name.trim()) keys.push(companyKey({ companyId: null, companyName: name }));
  const ref = url ? parseAtsJobUrl(url) : null;
  if (ref?.boardSlug) keys.push(`slug:${ref.boardSlug.toLowerCase()}`);
  return keys;
}

export type BackfillResult =
  | { created: string; title: string; companyName: string }
  | { created: null; reason: 'target_met' | 'no_candidate' | 'run_missing' };

/**
 * After an application of a run fails, applies to the next approved posting of the same run that
 * was not selected: rank order, a deadline not passed, a stashed job row, and a company with no
 * application of the user in any run or status (applied, pending, held or closed). Does nothing
 * while the run's live applications (applied, or pending with no failed attempt) already reach the
 * run's target. Runs under the user's lock, like hand-off, and enqueues after the commit.
 */
export async function backfillFromRun(
  handle: TenantHandle,
  params: { userId: string; runId: string; today: string },
  queue: SubmitQueue,
): Promise<BackfillResult> {
  const { userId, runId, today } = params;
  const result = await withUserLock(handle, userId, async (h): Promise<BackfillResult> => {
    const run = await getRun(h, runId);
    if (!run) return { created: null, reason: 'run_missing' };
    const apps = await listApplications(h, userId);
    const live = apps.filter(
      (a) =>
        a.runId === runId &&
        (a.status === 'applied' ||
          a.status === 'interviewing' ||
          a.status === 'offer' ||
          (a.status === 'pending' && a.attemptCount === 0)),
    );
    if (live.length >= run.targetN) return { created: null, reason: 'target_met' };

    const jobs = await listJobsByIds(
      h,
      apps.map((a) => a.jobId),
    );
    const companyIds = [...new Set(jobs.flatMap((j) => (j.companyId ? [j.companyId] : [])))];
    const names = new Map(
      (await listCompaniesByIds(h, companyIds)).map((c) => [c.id, c.name] as const),
    );
    const blocked = new Set(
      jobs.flatMap((j) => companyKeysFor(j.companyId ? names.get(j.companyId) : null, j.url)),
    );
    const taken = new Set(
      jobs.map((j) => dedupeKey({ ats: j.ats, atsJobId: j.atsJobId, url: j.url })),
    );

    for (const rc of await listRunCandidates(h, runId)) {
      if (rc.selected || rc.rank === null) continue;
      const parsed = Judgment.safeParse(rc.judgment);
      if (!parsed.success || !parsed.data.apply) continue;
      const deadline = parsed.data.application_deadline;
      if (deadline && deadline < today) continue;
      if (companyKeysFor(rc.companyName, rc.url).some((k) => blocked.has(k))) continue;
      const job = await findJob(h, {
        ats: rc.ats,
        atsJobId: rc.atsJobId,
        url: normalizeJobUrl(rc.url),
      });
      if (!job) continue;
      if (taken.has(dedupeKey({ ats: job.ats, atsJobId: job.atsJobId, url: job.url }))) continue;
      const { application, created } = await insertApplication(h, {
        userId,
        jobId: job.id,
        runId,
        status: 'pending',
        attemptCount: 0,
      });
      if (!created) continue;
      await selectRunCandidate(h, runId, rc.id);
      await activity.logActivity(h, {
        userId,
        applicationId: application.id,
        actor: 'agent',
        action: 'backfilled',
        detail: { run_id: runId, rank: rc.rank, company: rc.companyName, title: rc.title },
      });
      return { created: application.id, title: rc.title, companyName: rc.companyName };
    }
    return { created: null, reason: 'no_candidate' };
  });
  if (result.created) {
    await queue.enqueueSubmit({ tenantId: handle.tenantId, userId, applicationId: result.created });
  }
  return result;
}
