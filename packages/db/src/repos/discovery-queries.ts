import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { companies, runs } from '../schema';
import type { CompanyRow } from './companies';

/** Resolved boards whose company name matches (case-insensitive), from the global cache. */
export function listResolvedCompaniesByName(
  handle: TenantHandle,
  name: string,
): Promise<CompanyRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(companies)
      .where(and(isNotNull(companies.ats), sql`lower(${companies.name}) = lower(${name})`)),
  );
}

/**
 * Deletes the tenant's runs dated before `date` (`YYYY-MM-DD`); run_candidates cascade.
 * Jobs and applications are untouched (applications.run_id is set null by the foreign key).
 */
export async function deleteRunsBefore(handle: TenantHandle, date: string): Promise<number> {
  const rows = await handle.run((tx) =>
    tx
      .delete(runs)
      .where(and(eq(runs.tenantId, handle.tenantId), lt(runs.date, date)))
      .returning({ id: runs.id }),
  );
  return rows.length;
}
