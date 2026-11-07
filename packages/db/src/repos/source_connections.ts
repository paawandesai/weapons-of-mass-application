import { and, eq, inArray } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { sourceConnections } from '../schema';

export type SourceConnectionRow = typeof sourceConnections.$inferSelect;
export type SourceKind = SourceConnectionRow['kind'];
export type SourceStatus = SourceConnectionRow['status'];

export interface ConnectionInput {
  userId: string;
  kind: SourceKind;
  status?: SourceStatus;
  config?: Record<string, unknown>;
  fileRef?: string | null;
}

export async function getConnection(
  handle: TenantHandle,
  userId: string,
  kind: SourceKind,
): Promise<SourceConnectionRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.tenantId, handle.tenantId),
          eq(sourceConnections.userId, userId),
          eq(sourceConnections.kind, kind),
        ),
      ),
  );
  return rows[0] ?? null;
}

export function listConnections(
  handle: TenantHandle,
  userId: string,
): Promise<SourceConnectionRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(sourceConnections)
      .where(
        and(eq(sourceConnections.tenantId, handle.tenantId), eq(sourceConnections.userId, userId)),
      )
      .orderBy(sourceConnections.kind),
  );
}

/** Connections a build may read: status connected or partial. Disconnected ones are excluded. */
export function listActiveConnections(
  handle: TenantHandle,
  userId: string,
): Promise<SourceConnectionRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.tenantId, handle.tenantId),
          eq(sourceConnections.userId, userId),
          inArray(sourceConnections.status, ['connected', 'partial']),
        ),
      )
      .orderBy(sourceConnections.kind),
  );
}

/**
 * One row per (user, kind), enforced by a unique index: a single `insert ... on conflict do update`
 * creates the row or reconnects the existing one (replacing its config and clearing
 * disconnected_at), so concurrent first connections cannot produce duplicates.
 */
export async function upsertConnection(
  handle: TenantHandle,
  input: ConnectionInput,
): Promise<SourceConnectionRow> {
  const values = {
    status: input.status ?? ('connected' as const),
    config: input.config ?? {},
    fileRef: input.fileRef ?? null,
    connectedAt: new Date(),
    disconnectedAt: null,
  };
  const rows = await handle.run((tx) =>
    tx
      .insert(sourceConnections)
      .values({ tenantId: handle.tenantId, userId: input.userId, kind: input.kind, ...values })
      .onConflictDoUpdate({
        target: [sourceConnections.tenantId, sourceConnections.userId, sourceConnections.kind],
        set: values,
      })
      .returning(),
  );
  return rows[0]!;
}

/** Merges keys into config and optionally changes status, without touching the file ref. */
export async function updateConnection(
  handle: TenantHandle,
  userId: string,
  kind: SourceKind,
  patch: { status?: SourceStatus; config?: Record<string, unknown> },
): Promise<SourceConnectionRow | null> {
  return handle.transaction(async (h) => {
    const existing = await getConnection(h, userId, kind);
    if (!existing) return null;
    const rows = await h.run((tx) =>
      tx
        .update(sourceConnections)
        .set({
          status: patch.status ?? existing.status,
          config: { ...((existing.config as Record<string, unknown>) ?? {}), ...patch.config },
        })
        .where(
          and(eq(sourceConnections.tenantId, h.tenantId), eq(sourceConnections.id, existing.id)),
        )
        .returning(),
    );
    return rows[0] ?? null;
  });
}

/**
 * Marks the connection disconnected, drops its config and file reference, and returns the row as
 * it was before (so the caller can delete the stored file). Null when there was nothing to
 * disconnect.
 */
export async function disconnectConnection(
  handle: TenantHandle,
  userId: string,
  kind: SourceKind,
): Promise<SourceConnectionRow | null> {
  return handle.transaction(async (h) => {
    const existing = await getConnection(h, userId, kind);
    if (!existing) return null;
    await h.run((tx) =>
      tx
        .update(sourceConnections)
        .set({ status: 'disconnected', config: {}, fileRef: null, disconnectedAt: new Date() })
        .where(
          and(eq(sourceConnections.tenantId, h.tenantId), eq(sourceConnections.id, existing.id)),
        ),
    );
    return existing;
  });
}
