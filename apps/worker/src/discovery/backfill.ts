import { activity, getApplication, type Db } from '@wma/db';
import { backfillFromRun, type BackfillResult, type SubmitQueue } from './handoff';
import { utcDate } from './text';

/** A first failure is tried once more the same day, this long after it (seconds). */
export const SAME_DAY_RETRY_DELAY_S = 10 * 60;

export interface AttemptReport {
  tenantId: string;
  userId: string;
  applicationId: string;
}

export interface AfterAttemptResult {
  retried: boolean;
  backfill: BackfillResult | null;
}

/**
 * Called after every submission attempt. On an application's FIRST failed attempt it does two
 * things right away instead of waiting for the next day's run:
 *  - moves on: applies to the next approved company of the same run (`backfillFromRun`), and
 *  - keeps the one retry the row is allowed, but the same day: the attempt is queued again after
 *    SAME_DAY_RETRY_DELAY_S (a row still pending; `unsupported-ats` is never retried).
 * The second failure closes the row as before and triggers nothing more, so one failing posting
 * backfills exactly once. Successes and duplicates do nothing.
 */
export async function afterSubmissionAttempt(
  db: Db,
  queue: SubmitQueue,
  data: AttemptReport,
  outcome: { outcome: string },
  now: () => Date = () => new Date(),
): Promise<AfterAttemptResult> {
  if (outcome.outcome !== 'pending' && outcome.outcome !== 'closed') {
    return { retried: false, backfill: null };
  }
  const handle = db.forTenant(data.tenantId);
  const app = await getApplication(handle, data.applicationId);
  if (!app || app.attemptCount > 1) return { retried: false, backfill: null };
  // A pending outcome with no failed attempt recorded is not a failure (nothing to move on from).
  if (outcome.outcome === 'pending' && app.attemptCount !== 1) {
    return { retried: false, backfill: null };
  }
  let retried = false;
  if (
    app.status === 'pending' &&
    app.attemptCount === 1 &&
    app.pendingReason !== 'unsupported-ats'
  ) {
    await queue.enqueueSubmit(data, { startAfterSeconds: SAME_DAY_RETRY_DELAY_S });
    retried = true;
    await activity.logActivity(handle, {
      userId: data.userId,
      applicationId: app.id,
      actor: 'agent',
      action: 'retry_scheduled',
      detail: { delay_seconds: SAME_DAY_RETRY_DELAY_S, last_reason: app.pendingReason },
    });
  }
  const backfill = app.runId
    ? await backfillFromRun(
        handle,
        { userId: data.userId, runId: app.runId, today: utcDate(now()) },
        queue,
      )
    : null;
  return { retried, backfill };
}
