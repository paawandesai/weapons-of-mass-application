import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { runs } from '../schema';

export type RunRow = typeof runs.$inferSelect;
export type RunStatus = RunRow['status'];
export type RunPatch = Partial<
  Pick<
    RunRow,
    | 'status'
    | 'step'
    | 'endedAt'
    | 'sourceStatus'
    | 'counts'
    | 'shortDay'
    | 'shortfall'
    | 'error'
    | 'targetN'
    | 'dispatchState'
  >
>;

export interface RunInput {
  userId: string;
  /** The run date, `YYYY-MM-DD` (UTC). */
  date: string;
  trigger?: RunRow['trigger'];
  targetN: number;
  status?: RunStatus;
  step?: string | null;
  dispatchState?: RunRow['dispatchState'];
}

/**
 * Starts the user's run for a date. The partial unique index (user_id, date) where status <>
 * 'failed' decides the winner: a second call returns the existing run with `created: false`.
 */
export async function insertRun(
  handle: TenantHandle,
  input: RunInput,
): Promise<{ run: RunRow; created: boolean }> {
  const inserted = await handle.run((tx) =>
    tx
      .insert(runs)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        date: input.date,
        trigger: input.trigger ?? 'scheduled',
        targetN: input.targetN,
        status: input.status ?? 'running',
        step: input.step ?? null,
        dispatchState: input.dispatchState ?? null,
      })
      .onConflictDoNothing({ target: [runs.userId, runs.date], where: sql`status <> 'failed'` })
      .returning(),
  );
  if (inserted[0]) return { run: inserted[0], created: true };
  const existing = await getRunForDate(handle, input.userId, input.date);
  if (!existing) throw new Error('run insert conflicted but no run exists for the date');
  return { run: existing, created: false };
}

export async function getRun(handle: TenantHandle, id: string): Promise<RunRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, handle.tenantId), eq(runs.id, id))),
  );
  return rows[0] ?? null;
}

/** The user's non-failed run for the date, if any. */
export async function getRunForDate(
  handle: TenantHandle,
  userId: string,
  date: string,
): Promise<RunRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, handle.tenantId),
          eq(runs.userId, userId),
          eq(runs.date, date),
          ne(runs.status, 'failed'),
        ),
      ),
  );
  return rows[0] ?? null;
}

export async function getLatestRun(handle: TenantHandle, userId: string): Promise<RunRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, handle.tenantId), eq(runs.userId, userId)))
      .orderBy(desc(runs.date), desc(runs.startedAt))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function updateRun(
  handle: TenantHandle,
  id: string,
  patch: RunPatch,
): Promise<RunRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(runs)
      .set(patch)
      .where(and(eq(runs.tenantId, handle.tenantId), eq(runs.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * Compare-and-set: applies `patch` only while the row still has the expected status (and step,
 * when given), so two actors racing for the same row cannot both win. Returns the updated row, or
 * null when the row had already moved on; callers then read the winner's state.
 */
export async function transitionRun(
  handle: TenantHandle,
  id: string,
  expected: {
    status: RunStatus;
    step?: string | null;
    dispatchState?: Array<RunRow['dispatchState']>;
  },
  patch: RunPatch,
): Promise<RunRow | null> {
  const conds = [
    eq(runs.tenantId, handle.tenantId),
    eq(runs.id, id),
    eq(runs.status, expected.status),
  ];
  if (expected.step !== undefined) {
    conds.push(expected.step === null ? isNull(runs.step) : eq(runs.step, expected.step));
  }
  if (expected.dispatchState) {
    const states = expected.dispatchState;
    const nonNull = states.filter((x): x is NonNullable<typeof x> => x !== null);
    const parts = [
      ...(nonNull.length ? [inArray(runs.dispatchState, nonNull)] : []),
      ...(states.includes(null) ? [isNull(runs.dispatchState)] : []),
    ];
    conds.push(or(...parts)!);
  }
  const rows = await handle.run((tx) =>
    tx
      .update(runs)
      .set(patch)
      .where(and(...conds))
      .returning(),
  );
  return rows[0] ?? null;
}
