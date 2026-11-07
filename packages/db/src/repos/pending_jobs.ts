import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { pendingJobs } from '../schema';

export type PendingJobRow = typeof pendingJobs.$inferSelect;

export interface PendingJobInput {
  userId: string;
  kind: string;
  payload?: Record<string, unknown>;
  /** Unique per tenant: a repeated trigger is one row. */
  dedupeKey: string;
}

/**
 * Records follow-on work. Call it with the handle of the parent transaction so the row commits
 * (or rolls back) with the change that needs the work. Idempotent on `dedupeKey`: a second call
 * returns the stored row, and re-arms it (clears `dispatched_at`) only when `rearm` is set.
 */
export async function insertPendingJob(
  handle: TenantHandle,
  input: PendingJobInput,
  opts: { rearm?: boolean } = {},
): Promise<PendingJobRow> {
  const rows = await handle.run((tx) =>
    tx
      .insert(pendingJobs)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        kind: input.kind,
        payload: input.payload ?? {},
        dedupeKey: input.dedupeKey,
      })
      .onConflictDoUpdate({
        target: [pendingJobs.tenantId, pendingJobs.dedupeKey],
        set: opts.rearm
          ? { payload: input.payload ?? {}, dispatchedAt: null }
          : { dedupeKey: input.dedupeKey },
      })
      .returning(),
  );
  return rows[0]!;
}

/** Oldest undispatched rows of the tenant. */
export async function listUndispatchedJobs(
  handle: TenantHandle,
  limit = 100,
): Promise<PendingJobRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(pendingJobs)
      .where(and(eq(pendingJobs.tenantId, handle.tenantId), isNull(pendingJobs.dispatchedAt)))
      .orderBy(asc(pendingJobs.createdAt))
      .limit(limit),
  );
}

export async function markJobsDispatched(handle: TenantHandle, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await handle.run((tx) =>
    tx
      .update(pendingJobs)
      .set({ dispatchedAt: new Date() })
      .where(and(eq(pendingJobs.tenantId, handle.tenantId), inArray(pendingJobs.id, ids))),
  );
}
