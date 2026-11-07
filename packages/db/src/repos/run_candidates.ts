import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { runCandidates } from '../schema';

export type RunCandidateRow = typeof runCandidates.$inferSelect;

export interface RunCandidateInput {
  title: string;
  companyName: string;
  url: string;
  ats?: RunCandidateRow['ats'];
  atsJobId?: string | null;
  judgment?: unknown;
  promptVersion?: string | null;
  model?: string | null;
  rank?: number | null;
  selected?: boolean;
  exclusionReason?: string | null;
}

/** Inserts every judged candidate of a run in one statement. */
export async function insertRunCandidates(
  handle: TenantHandle,
  runId: string,
  inputs: RunCandidateInput[],
): Promise<RunCandidateRow[]> {
  if (inputs.length === 0) return [];
  return handle.run((tx) =>
    tx
      .insert(runCandidates)
      .values(
        inputs.map((c) => ({
          runId,
          tenantId: handle.tenantId,
          title: c.title,
          companyName: c.companyName,
          url: c.url,
          ats: c.ats ?? null,
          atsJobId: c.atsJobId ?? null,
          judgment: c.judgment ?? null,
          promptVersion: c.promptVersion ?? null,
          model: c.model ?? null,
          rank: c.rank ?? null,
          selected: c.selected ?? false,
          exclusionReason: c.exclusionReason ?? null,
        })),
      )
      .returning(),
  );
}

/** Rank order (ranked rows first, then unranked ones by insertion order of id). */
export function listRunCandidates(handle: TenantHandle, runId: string): Promise<RunCandidateRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(runCandidates)
      .where(and(eq(runCandidates.tenantId, handle.tenantId), eq(runCandidates.runId, runId)))
      .orderBy(sql`${runCandidates.rank} asc nulls last`, asc(runCandidates.id)),
  );
}

/**
 * Clears `selected` on candidates that hand-off did not turn into applications (another run won
 * the posting first) and records why, so the stored selection matches the stored applications.
 */
export async function unselectRunCandidates(
  handle: TenantHandle,
  runId: string,
  ids: string[],
  reason: string,
): Promise<void> {
  if (ids.length === 0) return;
  await handle.run((tx) =>
    tx
      .update(runCandidates)
      .set({ selected: false, exclusionReason: reason })
      .where(
        and(
          eq(runCandidates.tenantId, handle.tenantId),
          eq(runCandidates.runId, runId),
          inArray(runCandidates.id, ids),
        ),
      ),
  );
}
