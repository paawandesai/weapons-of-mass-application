import {
  finishProfileBuild,
  getLatestProfileBuild,
  listActiveConnections,
  reserveProfileBuild,
  type TenantHandle,
} from '@wma/db';
import type { BuildStatus } from '@wma/shared';
import type { BuildQueue } from './queue';

/** A build running longer than this has its queue job checked; a dead job releases the build. */
export const BUILD_STALE_MS = 15 * 60 * 1000;

/** A resume is connected only when it is active and has extractable text. */
export async function hasResume(handle: TenantHandle, userId: string): Promise<boolean> {
  const conns = await listActiveConnections(handle, userId);
  return conns.some((c) => {
    if (c.kind !== 'resume') return false;
    const text = (c.config as Record<string, unknown> | null)?.text;
    return typeof text === 'string' && text.trim() !== '';
  });
}

/** Job states that mean pg-boss will never run or finish the job again. */
const ENDED_JOB_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Age alone never releases a running build. Once a running build is older than BUILD_STALE_MS the
 * queue is asked about its job: only when the job is gone (completed, failed, cancelled, purged)
 * is the build marked failed so a new one can be reserved. A queued or active job keeps its
 * reservation. Returns true when a stale build was released.
 */
export async function releaseDeadBuild(
  handle: TenantHandle,
  userId: string,
  queue: BuildQueue,
  now: Date,
): Promise<boolean> {
  const latest = await getLatestProfileBuild(handle, userId);
  if (!latest || latest.state !== 'running') return false;
  if (now.getTime() - latest.createdAt.getTime() < BUILD_STALE_MS) return false;
  const state = await queue.jobState(latest.id);
  if (state !== null && !ENDED_JOB_STATES.has(state)) return false;
  const released = await finishProfileBuild(handle, latest.id, {
    state: 'failed',
    reason: 'profile_build_timeout',
  });
  return released !== null;
}

/**
 * Reserves the user's single in-flight build (database-enforced) and enqueues its job. A request
 * made while a build is running returns that build instead of starting a second one.
 */
export async function requestProfileBuild(
  handle: TenantHandle,
  userId: string,
  queue: BuildQueue,
  now: Date = new Date(),
): Promise<string> {
  await releaseDeadBuild(handle, userId, queue, now);
  const { build, created } = await reserveProfileBuild(handle, userId);
  if (!created) return build.id;
  try {
    await queue.enqueueProfileBuild({ tenantId: handle.tenantId, userId, buildId: build.id });
  } catch (e) {
    await finishProfileBuild(handle, build.id, {
      state: 'failed',
      reason: 'profile_build_enqueue_failed',
    });
    throw e;
  }
  return build.id;
}

export async function getBuildStatus(
  handle: TenantHandle,
  userId: string,
  queue: BuildQueue,
  now: Date = new Date(),
): Promise<BuildStatus> {
  await releaseDeadBuild(handle, userId, queue, now);
  const b = await getLatestProfileBuild(handle, userId);
  if (!b) return { state: 'idle' };
  if (b.state === 'done') return { state: 'done', version: b.version ?? undefined };
  if (b.state === 'failed') return { state: 'failed', reason: b.reason ?? undefined };
  const step = b.step === 'extracting' || b.step === 'checking' ? b.step : 'gathering';
  return { state: 'running', step, started_at: b.createdAt.toISOString() };
}
