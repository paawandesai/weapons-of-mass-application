import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { companies } from '../schema';

/** Global ATS board cache: shared by every tenant, so these helpers never stamp a tenant id. */
export type CompanyRow = typeof companies.$inferSelect;
export type AtsKind = NonNullable<CompanyRow['ats']>;
export type CompanySource = CompanyRow['createdBy'];

export interface CompanyInput {
  name: string;
  ats?: AtsKind | null;
  boardSlug?: string | null;
  /** '' (default host) or 'eu'. */
  boardRegion?: string;
  boardUrl?: string | null;
  resolvedAt?: Date | null;
  unresolvedUntil?: Date | null;
  createdBy: CompanySource;
}

export async function getCompany(handle: TenantHandle, id: string): Promise<CompanyRow | null> {
  const rows = await handle.run((tx) => tx.select().from(companies).where(eq(companies.id, id)));
  return rows[0] ?? null;
}

export async function getCompanyByBoard(
  handle: TenantHandle,
  ats: AtsKind,
  boardSlug: string,
  boardRegion = '',
): Promise<CompanyRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.ats, ats),
          eq(companies.boardSlug, boardSlug),
          eq(companies.boardRegion, boardRegion),
        ),
      ),
  );
  return rows[0] ?? null;
}

/** Case-insensitive lookup of an unresolved (no ATS) company by name. */
export async function getUnresolvedCompanyByName(
  handle: TenantHandle,
  name: string,
): Promise<CompanyRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(companies)
      .where(and(isNull(companies.ats), sql`lower(${companies.name}) = lower(${name})`))
      .limit(1),
  );
  return rows[0] ?? null;
}

export function listCompaniesByIds(handle: TenantHandle, ids: string[]): Promise<CompanyRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return handle.run((tx) => tx.select().from(companies).where(inArray(companies.id, ids)));
}

/**
 * Resolved boards upsert on (ats, board_slug): a second call refreshes the URL and resolution
 * stamp and keeps the original name and creator. A company with no ATS is matched by name
 * (case-insensitive) and only its retry stamp is refreshed.
 */
export async function upsertCompany(
  handle: TenantHandle,
  input: CompanyInput,
): Promise<CompanyRow> {
  if (input.ats && input.boardSlug) {
    const rows = await handle.run((tx) =>
      tx
        .insert(companies)
        .values({
          name: input.name,
          ats: input.ats,
          boardSlug: input.boardSlug,
          boardRegion: input.boardRegion ?? '',
          boardUrl: input.boardUrl ?? null,
          resolvedAt: input.resolvedAt ?? new Date(),
          unresolvedUntil: null,
          createdBy: input.createdBy,
        })
        .onConflictDoUpdate({
          target: [companies.ats, companies.boardSlug, companies.boardRegion],
          targetWhere: sql`ats is not null`,
          set: {
            boardUrl: input.boardUrl ?? null,
            resolvedAt: input.resolvedAt ?? new Date(),
            unresolvedUntil: null,
          },
        })
        .returning(),
    );
    return rows[0]!;
  }
  return handle.transaction(async (h) => {
    const existing = await getUnresolvedCompanyByName(h, input.name);
    if (existing) {
      const rows = await h.run((tx) =>
        tx
          .update(companies)
          .set({ unresolvedUntil: input.unresolvedUntil ?? existing.unresolvedUntil })
          .where(eq(companies.id, existing.id))
          .returning(),
      );
      return rows[0]!;
    }
    // The partial unique index on lower(name) where ats is null decides concurrent inserts: the
    // loser re-reads the winner's row instead of forking a second identity for the same name.
    const rows = await h.run((tx) =>
      tx
        .insert(companies)
        .values({
          name: input.name,
          ats: null,
          boardSlug: null,
          boardUrl: null,
          unresolvedUntil: input.unresolvedUntil ?? null,
          createdBy: input.createdBy,
        })
        .onConflictDoNothing()
        .returning(),
    );
    if (rows[0]) return rows[0];
    const winner = await getUnresolvedCompanyByName(h, input.name);
    if (!winner) throw new Error('unresolved company insert conflicted but no row exists');
    return winner;
  });
}
