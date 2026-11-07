import {
  activity,
  getLatestProfile,
  getUserById,
  insertProfileVersion,
  lockUserForProfileWrite,
  NotFoundError,
  setApprovedProfileVersion,
  setDailyTarget,
  type ProfileRow,
  type TenantHandle,
} from '@wma/db';
import {
  profileDocumentSchema,
  unresolvedBlockingFlags,
  type ProfileDocument,
  type ProfileFlag,
  type ProfileResponse,
} from '@wma/shared';

export async function findLatestProfile(
  handle: TenantHandle,
  userId: string,
): Promise<ProfileRow | null> {
  try {
    return await getLatestProfile(handle, userId);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function getProfileResponse(
  handle: TenantHandle,
  userId: string,
): Promise<ProfileResponse | null> {
  const row = await findLatestProfile(handle, userId);
  if (!row) return null;
  const user = await getUserById(handle, userId);
  const document = profileDocumentSchema.parse(row.document);
  return {
    version: row.version,
    document,
    approved_version: user.approvedProfileVersion,
    approved_at: iso(user.approvedProfileAt),
    flags: document.flags,
    pending_review: user.approvedProfileVersion !== row.version,
  };
}

/** Saves the edited document as a new version. The approved version is untouched. */
export async function saveProfileDocument(
  handle: TenantHandle,
  userId: string,
  document: ProfileDocument,
): Promise<number> {
  return handle.transaction(async (h) => {
    await lockUserForProfileWrite(h, userId);
    const previous = await findLatestProfile(h, userId);
    const row = await insertProfileVersion(h, {
      userId,
      document,
      builtFrom: previous?.builtFrom ?? [],
    });
    const user = await getUserById(h, userId);
    if (user.dailyTarget !== document.survey.daily_target) {
      await setDailyTarget(h, userId, document.survey.daily_target);
    }
    await activity.logActivity(h, {
      userId,
      actor: 'user',
      action: 'profile_edited',
      detail: { version: row.version },
    });
    return row.version;
  });
}

export type ApproveResult =
  | { ok: true; approved_version: number; approved_at: string }
  | { ok: false; reason: 'no_profile' }
  | { ok: false; reason: 'version_mismatch'; latest_version: number }
  | { ok: false; reason: 'unresolved_flags'; flags: ProfileFlag[] };

/**
 * Approves the version the user reviewed, which must still be the latest: a rebuild or edit that
 * landed after the page loaded is refused (version_mismatch) rather than approved unseen. Also
 * refused while a date conflict or unsupported entry flag is still present.
 */
export async function approveProfileVersion(
  handle: TenantHandle,
  userId: string,
  version: number,
): Promise<ApproveResult> {
  return handle.transaction(async (h) => {
    await lockUserForProfileWrite(h, userId);
    const row = await findLatestProfile(h, userId);
    if (!row) return { ok: false, reason: 'no_profile' } as const;
    if (row.version !== version)
      return { ok: false, reason: 'version_mismatch', latest_version: row.version } as const;
    const document = profileDocumentSchema.parse(row.document);
    const blocking = unresolvedBlockingFlags(document.flags);
    if (blocking.length > 0)
      return { ok: false, reason: 'unresolved_flags', flags: blocking } as const;
    const before = await getUserById(h, userId);
    if (before.approvedProfileVersion === row.version && before.approvedProfileAt) {
      return {
        ok: true,
        approved_version: row.version,
        approved_at: before.approvedProfileAt.toISOString(),
      } as const;
    }
    const user = await setApprovedProfileVersion(h, userId, row.version);
    await activity.logActivity(h, {
      userId,
      actor: 'user',
      action: 'profile_approved',
      detail: { version: row.version },
    });
    return {
      ok: true,
      approved_version: row.version,
      approved_at: user.approvedProfileAt!.toISOString(),
    } as const;
  });
}
