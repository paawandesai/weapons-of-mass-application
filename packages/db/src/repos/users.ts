import { and, eq } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { NotFoundError } from '../errors';
import { profiles, users } from '../schema';

export type User = typeof users.$inferSelect;
export interface NewUser {
  email: string;
  googleSub: string;
  displayName?: string | null;
  digestHour?: number;
  timezone?: string;
  dailyTarget?: number;
}

export async function createUser(handle: TenantHandle, input: NewUser): Promise<User> {
  // tenant_id is always stamped from the handle; a caller-supplied value is discarded.
  const { email, googleSub, displayName, digestHour, timezone, dailyTarget } = input;
  const rows = await handle.run((tx) =>
    tx
      .insert(users)
      .values({
        email,
        googleSub,
        displayName,
        digestHour,
        timezone,
        dailyTarget,
        tenantId: handle.tenantId,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function getUserById(handle: TenantHandle, id: string): Promise<User> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(users)
      .where(and(eq(users.tenantId, handle.tenantId), eq(users.id, id))),
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('user');
  return row;
}

export async function listUsers(handle: TenantHandle): Promise<User[]> {
  return handle.run((tx) => tx.select().from(users).where(eq(users.tenantId, handle.tenantId)));
}

/** Points the user at an approved profile version and stamps the approval time. The version row must exist. */
export async function setApprovedProfileVersion(
  handle: TenantHandle,
  userId: string,
  version: number,
): Promise<User> {
  return handle.transaction(async (h) => {
    const exists = await h.run((tx) =>
      tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.tenantId, h.tenantId),
            eq(profiles.userId, userId),
            eq(profiles.version, version),
          ),
        ),
    );
    if (!exists[0]) throw new NotFoundError('profile version');
    const rows = await h.run((tx) =>
      tx
        .update(users)
        .set({ approvedProfileVersion: version, approvedProfileAt: new Date() })
        .where(and(eq(users.tenantId, h.tenantId), eq(users.id, userId)))
        .returning(),
    );
    if (!rows[0]) throw new NotFoundError('user');
    return rows[0];
  });
}

/** Survey daily target mirrored onto the user row (1 to 30 is validated by the caller). */
export async function setDailyTarget(
  handle: TenantHandle,
  userId: string,
  dailyTarget: number,
): Promise<User> {
  const rows = await handle.run((tx) =>
    tx
      .update(users)
      .set({ dailyTarget })
      .where(and(eq(users.tenantId, handle.tenantId), eq(users.id, userId)))
      .returning(),
  );
  if (!rows[0]) throw new NotFoundError('user');
  return rows[0];
}

/** Digest hour (0-23) and IANA time zone; the caller validates both. Only given fields change. */
export async function setNotificationSettings(
  handle: TenantHandle,
  userId: string,
  settings: { digestHour?: number; timezone?: string },
): Promise<User> {
  const set = {
    ...(settings.digestHour !== undefined ? { digestHour: settings.digestHour } : {}),
    ...(settings.timezone !== undefined ? { timezone: settings.timezone } : {}),
  };
  if (Object.keys(set).length === 0) return getUserById(handle, userId);
  const rows = await handle.run((tx) =>
    tx
      .update(users)
      .set(set)
      .where(and(eq(users.tenantId, handle.tenantId), eq(users.id, userId)))
      .returning(),
  );
  if (!rows[0]) throw new NotFoundError('user');
  return rows[0];
}
