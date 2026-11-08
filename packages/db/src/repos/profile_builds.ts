import { and, desc, eq, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { profileBuilds } from '../schema';

export type ProfileBuildRow = typeof profileBuilds.$inferSelect;

export interface BuildReservation {
  build: ProfileBuildRow;
  /** True when this call created the row; false when it returned the user's running build. */
  created: boolean;
}

async function findRunningBuild(
  handle: TenantHandle,
  userId: string,
): Promise<ProfileBuildRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(profileBuilds)
      .where(
        and(
          eq(profileBuilds.tenantId, handle.tenantId),
          eq(profileBuilds.userId, userId),
          eq(profileBuilds.state, 'running'),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Reserves the user's single in-flight build. One `insert ... on conflict do nothing` against the
 * partial unique index (user_id) where state = 'running' decides the winner, so two concurrent
 * requests can never both create a build; the loser gets the winner's row.
 */
export async function reserveProfileBuild(
  handle: TenantHandle,
  userId: string,
): Promise<BuildReservation> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await handle.run((tx) =>
      tx
        .insert(profileBuilds)
        .values({ tenantId: handle.tenantId, userId })
        .onConflictDoNothing({
          target: profileBuilds.userId,
          where: sql`state = 'running'`,
        })
        .returning(),
    );
    if (inserted[0]) return { build: inserted[0], created: true };
    // The conflicting row is committed by now; if it finished in between, try the insert again.
    const running = await findRunningBuild(handle, userId);
    if (running) return { build: running, created: false };
  }
  throw new Error('could not reserve a profile build');
}

/** Creates the user's build row, or returns the one already running. */
export async function startProfileBuild(
  handle: TenantHandle,
  userId: string,
): Promise<ProfileBuildRow> {
  return (await reserveProfileBuild(handle, userId)).build;
}

/**
 * Records the outcome of a build. Applies only while the row is still running: a build that was
 * already finished (or superseded) is left alone and null is returned, which is the worker's fence.
 */
export async function finishProfileBuild(
  handle: TenantHandle,
  id: string,
  result: { state: 'done'; version: number } | { state: 'failed'; reason: string },
): Promise<ProfileBuildRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(profileBuilds)
      .set({
        state: result.state,
        version: result.state === 'done' ? result.version : null,
        reason: result.state === 'failed' ? result.reason : null,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(profileBuilds.tenantId, handle.tenantId),
          eq(profileBuilds.id, id),
          eq(profileBuilds.state, 'running'),
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

/** Records the phase of a build; applies only while the row is still running. */
export async function setProfileBuildStep(
  handle: TenantHandle,
  id: string,
  step: string,
): Promise<void> {
  await handle.run((tx) =>
    tx
      .update(profileBuilds)
      .set({ step })
      .where(
        and(
          eq(profileBuilds.tenantId, handle.tenantId),
          eq(profileBuilds.id, id),
          eq(profileBuilds.state, 'running'),
        ),
      ),
  );
}

/** Locks the build row if it is still running; false when it finished, failed or does not exist. */
export async function lockRunningBuild(handle: TenantHandle, id: string): Promise<boolean> {
  const rows = await handle.run((tx) =>
    tx
      .select({ id: profileBuilds.id })
      .from(profileBuilds)
      .where(
        and(
          eq(profileBuilds.tenantId, handle.tenantId),
          eq(profileBuilds.id, id),
          eq(profileBuilds.state, 'running'),
        ),
      )
      .for('update'),
  );
  return rows.length > 0;
}

/** Most recent build request for the user, or null when none was ever made. */
export async function getLatestProfileBuild(
  handle: TenantHandle,
  userId: string,
): Promise<ProfileBuildRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(profileBuilds)
      .where(and(eq(profileBuilds.tenantId, handle.tenantId), eq(profileBuilds.userId, userId)))
      .orderBy(desc(profileBuilds.createdAt))
      .limit(1),
  );
  return rows[0] ?? null;
}
