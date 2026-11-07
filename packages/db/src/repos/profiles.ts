import { and, desc, eq, sql } from 'drizzle-orm';
import { profileDocumentSchema, type ProfileDocument } from '@wma/shared';
import type { TenantHandle } from '../client';
import { NotFoundError, ProfileNotApprovedError } from '../errors';
import { profiles, users } from '../schema';

export type ProfileRow = typeof profiles.$inferSelect;

/**
 * Takes the per-user write lock (`select ... from users for update`) for the rest of the current
 * transaction. Callers that read a profile and then write a new version (survey save, profile edit,
 * build publish) call this first so the read and the insert are one serialized unit.
 */
export async function lockUserForProfileWrite(handle: TenantHandle, userId: string): Promise<void> {
  const rows = await handle.run((tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, handle.tenantId), eq(users.id, userId)))
      .for('update'),
  );
  if (!rows[0]) throw new NotFoundError('user');
}

/**
 * Stores a new version (max + 1 for the user). Never touches users.approved_profile_version:
 * a rebuild waits for explicit approval. The user row is locked in the same transaction as the
 * insert, so concurrent writers get consecutive versions instead of a unique violation.
 */
export async function insertProfileVersion(
  handle: TenantHandle,
  input: { userId: string; document: ProfileDocument; builtFrom?: unknown },
): Promise<ProfileRow> {
  const document = profileDocumentSchema.parse(input.document);
  return handle.transaction(async (h) => {
    await lockUserForProfileWrite(h, input.userId);
    const rows = await h.run((tx) =>
      tx
        .insert(profiles)
        .values({
          tenantId: h.tenantId,
          userId: input.userId,
          version: sql`(select coalesce(max(p.version), 0) + 1 from profiles p where p.tenant_id = ${h.tenantId}::uuid and p.user_id = ${input.userId}::uuid)`,
          document,
          builtFrom: input.builtFrom ?? {},
        })
        .returning(),
    );
    return rows[0]!;
  });
}

export async function getProfileVersion(
  handle: TenantHandle,
  userId: string,
  version: number,
): Promise<ProfileRow> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(profiles)
      .where(
        and(
          eq(profiles.tenantId, handle.tenantId),
          eq(profiles.userId, userId),
          eq(profiles.version, version),
        ),
      ),
  );
  if (!rows[0]) throw new NotFoundError('profile');
  return rows[0];
}

export async function getLatestProfile(handle: TenantHandle, userId: string): Promise<ProfileRow> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(profiles)
      .where(and(eq(profiles.tenantId, handle.tenantId), eq(profiles.userId, userId)))
      .orderBy(desc(profiles.version))
      .limit(1),
  );
  if (!rows[0]) throw new NotFoundError('profile');
  return rows[0];
}

/**
 * Returns the approved profile version or throws ProfileNotApprovedError. A user whose pointer
 * references a missing version row, an unknown user and another tenant's user all count as
 * not approved.
 */
export async function requireApprovedProfile(
  handle: TenantHandle,
  userId: string,
): Promise<number> {
  const rows = await handle.run((tx) =>
    tx
      .select({ version: users.approvedProfileVersion })
      .from(users)
      .where(and(eq(users.tenantId, handle.tenantId), eq(users.id, userId))),
  );
  const version = rows[0]?.version;
  if (version == null) throw new ProfileNotApprovedError(userId);
  const exists = await handle.run((tx) =>
    tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          eq(profiles.tenantId, handle.tenantId),
          eq(profiles.userId, userId),
          eq(profiles.version, version),
        ),
      ),
  );
  if (!exists[0]) throw new ProfileNotApprovedError(userId);
  return version;
}
