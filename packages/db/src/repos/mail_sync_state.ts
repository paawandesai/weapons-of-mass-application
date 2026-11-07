import { and, eq } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { mailSyncState } from '../schema';

export type MailSyncStateRow = typeof mailSyncState.$inferSelect;

export async function getMailSyncState(
  handle: TenantHandle,
  userId: string,
): Promise<MailSyncStateRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(mailSyncState)
      .where(and(eq(mailSyncState.tenantId, handle.tenantId), eq(mailSyncState.userId, userId))),
  );
  return rows[0] ?? null;
}

export interface MailSyncPatch {
  historyId?: string | null;
  lastSyncedAt?: Date | null;
  reauthNeeded?: boolean;
  /** Listed messages not yet processed (calendar unreadable); replaces the stored list. */
  deferredMessageIds?: string[];
}

/** Creates the row on first use. Only the fields present in `patch` are written. */
export async function upsertMailSyncState(
  handle: TenantHandle,
  userId: string,
  patch: MailSyncPatch,
): Promise<MailSyncStateRow> {
  const rows = await handle.run((tx) =>
    tx
      .insert(mailSyncState)
      .values({
        tenantId: handle.tenantId,
        userId,
        historyId: patch.historyId ?? null,
        lastSyncedAt: patch.lastSyncedAt ?? null,
        reauthNeeded: patch.reauthNeeded ?? false,
        deferredMessageIds: patch.deferredMessageIds ?? [],
      })
      .onConflictDoUpdate({
        target: [mailSyncState.tenantId, mailSyncState.userId],
        set: {
          ...(patch.historyId !== undefined ? { historyId: patch.historyId } : {}),
          ...(patch.lastSyncedAt !== undefined ? { lastSyncedAt: patch.lastSyncedAt } : {}),
          ...(patch.reauthNeeded !== undefined ? { reauthNeeded: patch.reauthNeeded } : {}),
          ...(patch.deferredMessageIds !== undefined
            ? { deferredMessageIds: patch.deferredMessageIds }
            : {}),
        },
      })
      .returning(),
  );
  return rows[0]!;
}
