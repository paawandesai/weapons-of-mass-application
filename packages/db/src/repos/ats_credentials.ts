import { and, eq, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { atsCredentials } from '../schema';
import type { AtsKind } from './companies';

export type AtsCredentialRow = typeof atsCredentials.$inferSelect;

export interface AtsCredentialInput {
  userId: string;
  ats: AtsKind;
  companyId: string;
  username: string;
  /** Vault reference, `<ats>:<company_id>`; the password is read from the vault, never stored here. */
  vaultRef: string;
}

/** Plain insert: a second credential for the same (user, ats, company) violates the unique key. */
export async function insertAtsCredential(
  handle: TenantHandle,
  input: AtsCredentialInput,
): Promise<AtsCredentialRow> {
  const rows = await handle.run((tx) =>
    tx
      .insert(atsCredentials)
      .values({ tenantId: handle.tenantId, ...input })
      .returning(),
  );
  return rows[0]!;
}

export async function getAtsCredential(
  handle: TenantHandle,
  userId: string,
  ats: AtsKind,
  companyId: string,
): Promise<AtsCredentialRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(atsCredentials)
      .where(
        and(
          eq(atsCredentials.tenantId, handle.tenantId),
          eq(atsCredentials.userId, userId),
          eq(atsCredentials.ats, ats),
          eq(atsCredentials.companyId, companyId),
        ),
      ),
  );
  return rows[0] ?? null;
}

export function listAtsCredentials(
  handle: TenantHandle,
  userId: string,
): Promise<AtsCredentialRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(atsCredentials)
      .where(and(eq(atsCredentials.tenantId, handle.tenantId), eq(atsCredentials.userId, userId))),
  );
}

/**
 * Runs `fn` while holding a transaction-scoped advisory lock keyed on (user, ats, company). The
 * lock lives on a transaction of its own; `fn` works through other connections and commits its
 * own writes, so a crash inside `fn` cannot roll back a credential or vault write that already
 * happened. A second caller for the same key waits here until the first finishes.
 */
export async function withCredentialLock<T>(
  handle: TenantHandle,
  key: { userId: string; ats: AtsKind; companyId: string },
  fn: () => Promise<T>,
): Promise<T> {
  return handle.transaction(async (h) => {
    await h.run((tx) =>
      tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ats-credential:${handle.tenantId}:${key.userId}:${key.ats}:${key.companyId}`}, 0))`,
      ),
    );
    return fn();
  });
}

/**
 * Stamps the start of registration. The first stamp stands: a resumed sign-up for the same
 * credential keeps it, so verification mail from the interrupted attempt still counts.
 */
export async function startAtsRegistration(
  handle: TenantHandle,
  id: string,
  at: Date,
): Promise<AtsCredentialRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(atsCredentials)
      .set({
        status: 'registering',
        registrationStartedAt: sql`coalesce(${atsCredentials.registrationStartedAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(and(eq(atsCredentials.tenantId, handle.tenantId), eq(atsCredentials.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

export async function markAtsCredentialVerified(
  handle: TenantHandle,
  id: string,
): Promise<AtsCredentialRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(atsCredentials)
      .set({ status: 'verified' })
      .where(and(eq(atsCredentials.tenantId, handle.tenantId), eq(atsCredentials.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

export async function markAtsCredentialRejected(
  handle: TenantHandle,
  id: string,
): Promise<AtsCredentialRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(atsCredentials)
      .set({ rejectedAt: new Date(), status: 'rejected' })
      .where(and(eq(atsCredentials.tenantId, handle.tenantId), eq(atsCredentials.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}
