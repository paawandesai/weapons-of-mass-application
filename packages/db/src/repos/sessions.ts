import { and, eq } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { NotFoundError } from '../errors';
import { sessions } from '../schema';

export type Session = typeof sessions.$inferSelect;

export async function createSession(
  handle: TenantHandle,
  input: { id: string; userId: string; expiresAt: Date },
): Promise<Session> {
  const rows = await handle.run((tx) =>
    tx
      .insert(sessions)
      .values({
        id: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt,
        tenantId: handle.tenantId,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function getSession(handle: TenantHandle, id: string): Promise<Session> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, handle.tenantId), eq(sessions.id, id))),
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('session');
  return row;
}

/** Slides the expiry forward and records the access time. */
export async function touchSession(
  handle: TenantHandle,
  id: string,
  expiresAt: Date,
): Promise<Session> {
  const rows = await handle.run((tx) =>
    tx
      .update(sessions)
      .set({ expiresAt, lastSeenAt: new Date() })
      .where(and(eq(sessions.tenantId, handle.tenantId), eq(sessions.id, id)))
      .returning(),
  );
  if (!rows[0]) throw new NotFoundError('session');
  return rows[0];
}

export async function deleteSession(handle: TenantHandle, id: string): Promise<void> {
  await handle.run((tx) =>
    tx.delete(sessions).where(and(eq(sessions.tenantId, handle.tenantId), eq(sessions.id, id))),
  );
}
