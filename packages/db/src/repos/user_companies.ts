import { and, asc, eq, isNull } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { companies, userCompanies } from '../schema';
import type { CompanyRow, CompanySource } from './companies';

export type UserCompanyRow = typeof userCompanies.$inferSelect;

export interface UserCompanyInput {
  userId: string;
  companyId: string;
  source: CompanySource;
  reason?: string | null;
}

export async function getUserCompany(
  handle: TenantHandle,
  userId: string,
  companyId: string,
): Promise<UserCompanyRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(userCompanies)
      .where(
        and(
          eq(userCompanies.tenantId, handle.tenantId),
          eq(userCompanies.userId, userId),
          eq(userCompanies.companyId, companyId),
        ),
      ),
  );
  return rows[0] ?? null;
}

/**
 * Adds a company to the user's list. An existing row is returned unchanged, so regeneration never
 * resurrects a company the user removed; use restoreUserCompany for an explicit re-add.
 */
export async function upsertUserCompany(
  handle: TenantHandle,
  input: UserCompanyInput,
): Promise<{ row: UserCompanyRow; created: boolean }> {
  const inserted = await handle.run((tx) =>
    tx
      .insert(userCompanies)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        companyId: input.companyId,
        source: input.source,
        reason: input.reason ?? null,
      })
      .onConflictDoNothing({ target: [userCompanies.userId, userCompanies.companyId] })
      .returning(),
  );
  if (inserted[0]) return { row: inserted[0], created: true };
  return { row: (await getUserCompany(handle, input.userId, input.companyId))!, created: false };
}

/** Sets removed_at; null when the user has no such row. */
export async function removeUserCompany(
  handle: TenantHandle,
  userId: string,
  companyId: string,
): Promise<UserCompanyRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(userCompanies)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(userCompanies.tenantId, handle.tenantId),
          eq(userCompanies.userId, userId),
          eq(userCompanies.companyId, companyId),
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

/** Clears removed_at (the user adds back a company they removed). */
export async function restoreUserCompany(
  handle: TenantHandle,
  userId: string,
  companyId: string,
): Promise<UserCompanyRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(userCompanies)
      .set({ removedAt: null })
      .where(
        and(
          eq(userCompanies.tenantId, handle.tenantId),
          eq(userCompanies.userId, userId),
          eq(userCompanies.companyId, companyId),
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

export interface UserCompanyWithCompany {
  membership: UserCompanyRow;
  company: CompanyRow;
}

/** The user's list joined to the global cache; removed rows are excluded unless asked for. */
export async function listUserCompanies(
  handle: TenantHandle,
  userId: string,
  opts: { includeRemoved?: boolean } = {},
): Promise<UserCompanyWithCompany[]> {
  const conds = [eq(userCompanies.tenantId, handle.tenantId), eq(userCompanies.userId, userId)];
  if (!opts.includeRemoved) conds.push(isNull(userCompanies.removedAt));
  const rows = await handle.run((tx) =>
    tx
      .select({ membership: userCompanies, company: companies })
      .from(userCompanies)
      .innerJoin(companies, eq(companies.id, userCompanies.companyId))
      .where(and(...conds))
      .orderBy(asc(userCompanies.addedAt), asc(userCompanies.id)),
  );
  return rows;
}
