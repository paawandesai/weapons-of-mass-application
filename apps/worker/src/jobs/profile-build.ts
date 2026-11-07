import { activity, finishProfileBuild, type TenantHandle } from '@wma/db';
import { runProfileBuild, type BuildDeps } from '../profile/build';
import { BuildError, BuildSupersededError } from '../profile/types';

export const PROFILE_BUILD_JOB = 'profile.build';

export interface ProfileBuildJobData {
  tenantId: string;
  userId: string;
  buildId: string;
}

/**
 * The profile.build handler body. Deliberately NOT wrapped in guardedJob: this job is how a
 * profile becomes approvable. On success the profile, the build's `done` status and the
 * `profile_built` entry are committed together by runProfileBuild. On failure the `failed` status
 * and the `profile_build_failed` entry are committed together here. Both only apply while the
 * build row is still the user's running build; a superseded job publishes and records nothing.
 */
export async function executeProfileBuild(
  handle: TenantHandle,
  data: Pick<ProfileBuildJobData, 'userId' | 'buildId'>,
  deps: BuildDeps,
): Promise<{ version: number; flags: number } | { reason: string }> {
  const { userId, buildId } = data;
  try {
    const result = await runProfileBuild(handle, userId, deps, { buildId });
    return { version: result.version, flags: result.flags.length };
  } catch (e) {
    if (e instanceof BuildSupersededError) return { reason: 'profile_build_superseded' };
    const reason = e instanceof BuildError ? e.reason : 'profile_build_error';
    await handle.transaction(async (h) => {
      const finished = await finishProfileBuild(h, buildId, { state: 'failed', reason });
      if (!finished) return;
      await activity.logActivity(h, {
        userId,
        actor: 'agent',
        action: 'profile_build_failed',
        detail: {
          reason,
          ...(e instanceof BuildError && e.message !== reason
            ? { message: e.message.slice(0, 300) }
            : {}),
        },
      });
    });
    return { reason };
  }
}
