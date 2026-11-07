import { and, desc, eq, inArray } from 'drizzle-orm';
import { nextStatus, type Classification } from '@wma/shared';
import type { Db, TenantHandle } from '../client';
import { applications, jobs } from '../schema';
import type { AtsKind } from './companies';

export type ApplicationRow = typeof applications.$inferSelect;
export type ApplicationStatus = ApplicationRow['status'];
export type ApplicationPatch = Partial<
  Pick<
    ApplicationRow,
    | 'status'
    | 'pendingReason'
    | 'closedReason'
    | 'attemptCount'
    | 'resumePdfRef'
    | 'formAnswers'
    | 'unmetRequirements'
    | 'appliedAt'
    | 'followUpEnqueuedAt'
    | 'followedUpAt'
    | 'confirmationSource'
    | 'lastActivityAt'
  >
>;

export interface ApplicationInput {
  userId: string;
  jobId: string;
  runId?: string | null;
  status?: ApplicationStatus;
  attemptCount?: number;
}

/** One application per (user, job): a second insert returns the existing row with `created: false`. */
export async function insertApplication(
  handle: TenantHandle,
  input: ApplicationInput,
): Promise<{ application: ApplicationRow; created: boolean }> {
  const inserted = await handle.run((tx) =>
    tx
      .insert(applications)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        jobId: input.jobId,
        runId: input.runId ?? null,
        status: input.status ?? 'pending',
        attemptCount: input.attemptCount ?? 0,
      })
      .onConflictDoNothing({ target: [applications.userId, applications.jobId] })
      .returning(),
  );
  if (inserted[0]) return { application: inserted[0], created: true };
  const existing = await getApplicationByJob(handle, input.userId, input.jobId);
  if (!existing) throw new Error('application insert conflicted but no row exists');
  return { application: existing, created: false };
}

export async function getApplication(
  handle: TenantHandle,
  id: string,
): Promise<ApplicationRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(applications)
      .where(and(eq(applications.tenantId, handle.tenantId), eq(applications.id, id))),
  );
  return rows[0] ?? null;
}

export async function getApplicationByJob(
  handle: TenantHandle,
  userId: string,
  jobId: string,
): Promise<ApplicationRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.tenantId, handle.tenantId),
          eq(applications.userId, userId),
          eq(applications.jobId, jobId),
        ),
      ),
  );
  return rows[0] ?? null;
}

export function listApplications(
  handle: TenantHandle,
  userId: string,
  opts: { status?: ApplicationStatus[] } = {},
): Promise<ApplicationRow[]> {
  const conds = [eq(applications.tenantId, handle.tenantId), eq(applications.userId, userId)];
  if (opts.status?.length) conds.push(inArray(applications.status, opts.status));
  return handle.run((tx) =>
    tx
      .select()
      .from(applications)
      .where(and(...conds))
      .orderBy(desc(applications.createdAt), desc(applications.id)),
  );
}

/** Applies a patch and always bumps last_activity_at unless the patch sets it. */
export async function updateApplication(
  handle: TenantHandle,
  id: string,
  patch: ApplicationPatch,
): Promise<ApplicationRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(applications)
      .set({ ...patch, lastActivityAt: patch.lastActivityAt ?? new Date() })
      .where(and(eq(applications.tenantId, handle.tenantId), eq(applications.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * `select ... for update skip locked` on the application row. Returns null when another attempt
 * holds the row (or it does not exist). The lock lasts until the surrounding transaction ends, so
 * call it on a handle from `handle.transaction(...)` and keep the attempt inside that callback;
 * on a bare handle the lock is released as soon as this call returns.
 */
export async function lockForAttempt(
  handle: TenantHandle,
  id: string,
): Promise<ApplicationRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(applications)
      .where(and(eq(applications.tenantId, handle.tenantId), eq(applications.id, id)))
      .for('update', { skipLocked: true }),
  );
  return rows[0] ?? null;
}

export interface ApplicationJobKey {
  applicationId: string;
  ats: AtsKind | null;
  atsJobId: string | null;
  url: string;
}

/** Every job the user has an application for (any status), for the already-applied lookup. */
export function listApplicationJobKeys(
  handle: TenantHandle,
  userId: string,
): Promise<ApplicationJobKey[]> {
  return handle.run((tx) =>
    tx
      .select({
        applicationId: applications.id,
        ats: jobs.ats,
        atsJobId: jobs.atsJobId,
        url: jobs.url,
      })
      .from(applications)
      .innerJoin(
        jobs,
        and(eq(jobs.tenantId, applications.tenantId), eq(jobs.id, applications.jobId)),
      )
      .where(and(eq(applications.tenantId, handle.tenantId), eq(applications.userId, userId))),
  );
}

export interface FollowUpOwed {
  tenantId: string;
  userId: string;
  applicationId: string;
  appliedAt: Date;
}

/**
 * Applied applications whose follow-up job was never confirmed as enqueued (all tenants, oldest
 * first), through the pre-tenant lookup `wma_followups_owed`.
 */
export async function listFollowUpsOwed(
  db: Pick<Db, 'pool'>,
  limit = 200,
): Promise<FollowUpOwed[]> {
  const r = await db.pool.query<{
    tenant_id: string;
    user_id: string;
    application_id: string;
    applied_at: Date;
  }>('select * from wma_followups_owed($1)', [limit]);
  return r.rows.map((x) => ({
    tenantId: x.tenant_id,
    userId: x.user_id,
    applicationId: x.application_id,
    appliedAt: x.applied_at,
  }));
}

/** Records that the follow-up job is queued; leaves `last_activity_at` alone. */
export async function markFollowUpEnqueued(
  handle: TenantHandle,
  id: string,
  at: Date,
): Promise<void> {
  await handle.run((tx) =>
    tx
      .update(applications)
      .set({ followUpEnqueuedAt: at })
      .where(and(eq(applications.tenantId, handle.tenantId), eq(applications.id, id))),
  );
}

export type AppliedTransition =
  | { changed: false; reason: 'not_found' | 'no_change'; from: ApplicationStatus | null }
  | { changed: true; from: ApplicationStatus; to: ApplicationStatus; closedReason: string | null };

/**
 * Moves an application along `nextStatus` atomically against its CURRENT status: the row is
 * locked, the next status is computed from what is stored now (not from a caller's earlier
 * snapshot), and the update is conditioned on that same status. A rejection that committed
 * first is therefore never overwritten by a later interview or offer. Returns what changed.
 * For a confirmation on a pending card it also records `confirmation_source = email`.
 */
export function applyTransition(
  handle: TenantHandle,
  applicationId: string,
  classification: Classification,
  extras: {
    appliedAt?: Date;
    /**
     * Called with the change right after the row is updated, inside the transaction. Use it to
     * remember what happened; start side effects only after the transaction commits.
     */
    onTransition?: (change: Extract<AppliedTransition, { changed: true }>) => void;
  } = {},
): Promise<AppliedTransition> {
  return handle.run(async (tx) => {
    const rows = await tx
      .select()
      .from(applications)
      .where(and(eq(applications.tenantId, handle.tenantId), eq(applications.id, applicationId)))
      .for('update');
    const current = rows[0];
    if (!current) return { changed: false, reason: 'not_found', from: null } as const;
    const change = nextStatus(current.status, classification);
    if (!change) return { changed: false, reason: 'no_change', from: current.status } as const;
    const updated = await tx
      .update(applications)
      .set({
        status: change.status,
        ...(change.closedReason ? { closedReason: change.closedReason } : {}),
        ...(classification === 'confirmation' && current.status === 'pending'
          ? {
              confirmationSource: 'email' as const,
              appliedAt: current.appliedAt ?? extras.appliedAt ?? new Date(),
            }
          : {}),
        lastActivityAt: new Date(),
      })
      .where(
        and(
          eq(applications.tenantId, handle.tenantId),
          eq(applications.id, applicationId),
          eq(applications.status, current.status),
        ),
      )
      .returning({ id: applications.id });
    if (updated.length === 0)
      return { changed: false, reason: 'no_change', from: current.status } as const;
    const applied = {
      changed: true,
      from: current.status,
      to: change.status,
      closedReason: change.closedReason ?? null,
    } as const;
    extras.onTransition?.(applied);
    return applied;
  });
}

/** Stores the offer panel data. Leaves `last_activity_at` alone: gathering pay data is not card activity. */
export async function setNegotiation(
  handle: TenantHandle,
  id: string,
  negotiation: unknown,
): Promise<ApplicationRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(applications)
      .set({ negotiation })
      .where(and(eq(applications.tenantId, handle.tenantId), eq(applications.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}
