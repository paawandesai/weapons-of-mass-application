import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { interviews, pendingJobs } from '../schema';

export type InterviewRow = typeof interviews.$inferSelect;
export type InterviewPatch = Partial<
  Pick<
    InterviewRow,
    | 'confirmedSlotId'
    | 'confirmedAt'
    | 'calendarEventId'
    | 'replySentAt'
    | 'startsAt'
    | 'endsAt'
    | 'prepPlan'
    | 'prepPlanStatus'
    | 'feedback'
    | 'confirmationEmailSentAt'
    | 'calendarEventClientId'
    | 'bookedGeneration'
  >
>;

export interface InterviewInput {
  userId: string;
  applicationId: string;
  threadId: string;
}

/** One interview per application thread: a second insert returns the existing row. */
export async function insertInterview(
  handle: TenantHandle,
  input: InterviewInput,
): Promise<{ interview: InterviewRow; created: boolean }> {
  const inserted = await handle.run((tx) =>
    tx
      .insert(interviews)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        applicationId: input.applicationId,
        threadId: input.threadId,
      })
      .onConflictDoNothing({ target: [interviews.tenantId, interviews.threadId] })
      .returning(),
  );
  if (inserted[0]) return { interview: inserted[0], created: true };
  const existing = await getInterviewByThread(handle, input.threadId);
  if (!existing) throw new Error('interview insert conflicted but no row exists');
  return { interview: existing, created: false };
}

export async function getInterview(handle: TenantHandle, id: string): Promise<InterviewRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(and(eq(interviews.tenantId, handle.tenantId), eq(interviews.id, id))),
  );
  return rows[0] ?? null;
}

export async function getInterviewByThread(
  handle: TenantHandle,
  threadId: string,
): Promise<InterviewRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(and(eq(interviews.tenantId, handle.tenantId), eq(interviews.threadId, threadId))),
  );
  return rows[0] ?? null;
}

export function listInterviewsForApplication(
  handle: TenantHandle,
  applicationId: string,
): Promise<InterviewRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(
        and(eq(interviews.tenantId, handle.tenantId), eq(interviews.applicationId, applicationId)),
      )
      .orderBy(asc(interviews.createdAt), asc(interviews.id)),
  );
}

/** Confirmed interviews starting after `after`, soonest first (digest and reminders). */
export function listUpcomingInterviews(
  handle: TenantHandle,
  userId: string,
  after: Date,
): Promise<InterviewRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(
        and(
          eq(interviews.tenantId, handle.tenantId),
          eq(interviews.userId, userId),
          isNotNull(interviews.confirmedAt),
          gt(interviews.startsAt, after),
        ),
      )
      .orderBy(asc(interviews.startsAt), asc(interviews.id)),
  );
}

export async function updateInterview(
  handle: TenantHandle,
  id: string,
  patch: InterviewPatch,
): Promise<InterviewRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(interviews)
      .set(patch)
      .where(and(eq(interviews.tenantId, handle.tenantId), eq(interviews.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * Reads the interview row with `for update`, holding the lock until the surrounding transaction
 * ends. Call it on a handle from `handle.transaction(...)`; on a bare handle the lock is released
 * as soon as the call returns. Booking holds it while it reads the reply context and sends, so a
 * reschedule (which updates the same row) waits for it instead of interleaving.
 */
export async function lockInterview(
  handle: TenantHandle,
  id: string,
): Promise<InterviewRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(and(eq(interviews.tenantId, handle.tenantId), eq(interviews.id, id)))
      .for('update'),
  );
  return rows[0] ?? null;
}

/**
 * Updates the interview only while it is still on `generation` and has a confirmed slot. Every
 * booking write goes through this: a null result means a reschedule or a new confirmation got
 * there first and the caller's snapshot is obsolete.
 */
export async function updateInterviewIfGeneration(
  handle: TenantHandle,
  id: string,
  generation: number,
  patch: InterviewPatch,
): Promise<InterviewRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(interviews)
      .set(patch)
      .where(
        and(
          eq(interviews.tenantId, handle.tenantId),
          eq(interviews.id, id),
          eq(interviews.confirmedGeneration, generation),
          isNotNull(interviews.confirmedSlotId),
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * A reschedule: clears the confirmation and reply markers and bumps the generation so any
 * booking still in flight for the old slot fails its conditional writes. The Calendar event id
 * is kept; the event is updated when the replacement slot is confirmed.
 */
export async function clearConfirmationForReschedule(
  handle: TenantHandle,
  id: string,
): Promise<InterviewRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(interviews)
      .set({
        confirmedSlotId: null,
        confirmedAt: null,
        replySentAt: null,
        confirmationEmailSentAt: null,
        confirmedGeneration: sql`${interviews.confirmedGeneration} + 1`,
      })
      .where(and(eq(interviews.tenantId, handle.tenantId), eq(interviews.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

export interface FollowOnJobInput {
  userId: string;
  /** The queue the reconciler sends it to. */
  kind: string;
  payload: Record<string, unknown>;
  /** One row per key and tenant; recording the same key again re-arms the row for dispatch. */
  dedupeKey: string;
}

/**
 * Records follow-on work in the caller's transaction (the outbox). The reconciler sends it to the
 * queue afterwards, so a crash between the parent commit and the send loses nothing. A key that
 * was already dispatched is re-armed with the new payload.
 */
export async function recordFollowOnJob(
  handle: TenantHandle,
  input: FollowOnJobInput,
): Promise<void> {
  await handle.run((tx) =>
    tx
      .insert(pendingJobs)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        kind: input.kind,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
      })
      .onConflictDoUpdate({
        target: [pendingJobs.tenantId, pendingJobs.dedupeKey],
        set: { kind: input.kind, payload: input.payload, dispatchedAt: null },
      }),
  );
}

/** Marks an outbox row as sent after a direct enqueue succeeded (the reconciler skips it). */
export async function markFollowOnDispatched(
  handle: TenantHandle,
  dedupeKey: string,
): Promise<void> {
  await handle.run((tx) =>
    tx
      .update(pendingJobs)
      .set({ dispatchedAt: new Date() })
      .where(and(eq(pendingJobs.tenantId, handle.tenantId), eq(pendingJobs.dedupeKey, dedupeKey))),
  );
}

/** Interviews whose prep plan is marked pending; the repair pass re-records their outbox rows. */
export function listInterviewsPrepPending(
  handle: TenantHandle,
  userId: string,
): Promise<InterviewRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(
        and(
          eq(interviews.tenantId, handle.tenantId),
          eq(interviews.userId, userId),
          eq(interviews.prepPlanStatus, 'pending'),
        ),
      ),
  );
}
