import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import { createLlmClient, type StructuredLlm } from '@wma/llm';
import { negotiationKey, NEGOTIATION_QUEUE_OPTIONS } from '@wma/shared';
import { guardedJob } from '../guarded';
import { createPlaywrightLevelsFetcher, type LevelsFetcher } from '../negotiation/levels';
import { NEGOTIATION_JOB, runNegotiation, type NegotiationDeps } from '../negotiation/run';

export { NEGOTIATION_JOB };

export interface NegotiationJobData {
  tenantId: string;
  userId: string;
  applicationId: string;
}

/**
 * Enqueues the pay-data job for a card in Offer. One queued or running job per application; the
 * job itself reads and writes only, it has no mail path at all.
 */
export function enqueueNegotiation(boss: PgBoss, data: NegotiationJobData): Promise<string | null> {
  return boss.send(NEGOTIATION_JOB, data, {
    singletonKey: negotiationKey(data.applicationId),
    ...NEGOTIATION_QUEUE_OPTIONS,
  });
}

export interface NegotiationRegistration {
  llm?: StructuredLlm;
  fetchPage?: LevelsFetcher;
}

/** Runs one job behind the approval gate. Tests call this directly. */
export async function runNegotiationJob(
  db: Pick<Db, 'forTenant'>,
  data: NegotiationJobData,
  deps: NegotiationDeps,
) {
  const handle = db.forTenant(data.tenantId);
  return guardedJob(NEGOTIATION_JOB, (ctx) =>
    runNegotiation(
      ctx.handle,
      {
        userId: ctx.userId,
        applicationId: data.applicationId,
        approvedVersion: ctx.approvedVersion,
      },
      deps,
    ),
  )({ handle, userId: data.userId });
}

/** Registers the negotiation consumer. The LLM client is created on first use. */
export async function registerNegotiation(
  boss: PgBoss,
  db: Db,
  options: NegotiationRegistration = {},
): Promise<void> {
  let llm = options.llm;
  const fetchPage = options.fetchPage ?? createPlaywrightLevelsFetcher();
  await boss.createQueue(NEGOTIATION_JOB, NEGOTIATION_QUEUE_OPTIONS);
  await boss.work<NegotiationJobData>(NEGOTIATION_JOB, async (jobs) => {
    for (const job of jobs) {
      await runNegotiationJob(db, job.data, { llm: (llm ??= createLlmClient()), fetchPage });
    }
  });
}
