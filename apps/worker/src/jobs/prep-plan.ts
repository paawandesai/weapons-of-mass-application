import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { sharedHttp, type Http } from '@wma/discovery';
import { createLlmClient, type StructuredLlm } from '@wma/llm';
import { listInterviewsPrepPending, recordFollowOnJob, type TenantHandle } from '@wma/db';
import { PREP_PLAN_JOB, PREP_PLAN_QUEUE_OPTIONS, prepPlanKey } from '@wma/shared';
import { guardedJob } from '../guarded';
import { generatePrepPlan, type PrepPlanDeps } from '../prep/generate';

export { PREP_PLAN_JOB };

export interface PrepPlanJobData {
  tenantId: string;
  userId: string;
  interviewId: string;
  /** Set by the booking step: leave a plan that already exists alone. */
  onlyIfMissing?: boolean;
}

/**
 * Enqueues plan generation. The queue's exclusive policy plus the singleton key make a second
 * enqueue for the interview a no-op while one is queued or running. A job interrupted by a worker
 * crash is redelivered (retryLimit > 0); the handler rewrites the plan, so a repeat is harmless.
 */
export function enqueuePrepPlan(boss: PgBoss, data: PrepPlanJobData): Promise<string | null> {
  return boss.send(PREP_PLAN_JOB, data, {
    singletonKey: prepPlanKey(data.interviewId),
    ...PREP_PLAN_QUEUE_OPTIONS,
  });
}

/**
 * Re-arms the outbox row of every interview whose plan is marked pending, so the reconciler sends
 * the job again. Safe to run at any time: the exclusive queue refuses a duplicate while a job for
 * the interview is queued or running. Returns the interviews re-armed.
 */
export async function repairPendingPrepPlans(
  handle: TenantHandle,
  userId: string,
): Promise<number> {
  const pending = await listInterviewsPrepPending(handle, userId);
  for (const i of pending) {
    const data: PrepPlanJobData = { tenantId: handle.tenantId, userId, interviewId: i.id };
    await recordFollowOnJob(handle, {
      userId,
      kind: PREP_PLAN_JOB,
      payload: data as unknown as Record<string, unknown>,
      dedupeKey: prepPlanKey(i.id),
    });
  }
  return pending.length;
}

export interface PrepPlanRegistration {
  llm?: StructuredLlm;
  http?: Http;
  interviewerName?: PrepPlanDeps['interviewerName'];
}

/** Runs one job: the approval gate first, then the generator. Tests call this directly. */
export async function runPrepPlanJob(
  db: Pick<Db, 'forTenant'>,
  data: PrepPlanJobData,
  deps: PrepPlanDeps,
) {
  const handle = db.forTenant(data.tenantId);
  return guardedJob(PREP_PLAN_JOB, (ctx) =>
    generatePrepPlan(
      ctx.handle,
      {
        userId: ctx.userId,
        interviewId: data.interviewId,
        approvedVersion: ctx.approvedVersion,
        onlyIfMissing: data.onlyIfMissing,
      },
      deps,
    ),
  )({ handle, userId: data.userId });
}

/** Registers the prep-plan consumer. The LLM client is created on first use. */
export async function registerPrepPlan(
  boss: PgBoss,
  db: Db,
  options: PrepPlanRegistration = {},
): Promise<void> {
  let llm = options.llm;
  await boss.createQueue(PREP_PLAN_JOB, PREP_PLAN_QUEUE_OPTIONS);
  await boss.work<PrepPlanJobData>(PREP_PLAN_JOB, async (jobs) => {
    for (const job of jobs) {
      await runPrepPlanJob(db, job.data, {
        llm: (llm ??= createLlmClient()),
        http: options.http ?? sharedHttp(),
        interviewerName: options.interviewerName,
      });
    }
  });
}
