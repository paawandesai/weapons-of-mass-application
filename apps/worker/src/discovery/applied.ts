import { listApplicationJobKeys, type TenantHandle } from '@wma/db';
import { dedupeKey, type Candidate } from '@wma/shared';

/**
 * Drops every candidate whose dedupe key matches a job the user already has an application for
 * (any status). The same `dedupeKey` function serves in-run dedupe, so both sides agree.
 */
export async function dropAlreadyApplied(
  handle: TenantHandle,
  userId: string,
  candidates: Candidate[],
): Promise<{ kept: Candidate[]; dropped: Candidate[] }> {
  const keys = new Set(
    (await listApplicationJobKeys(handle, userId)).map((k) =>
      dedupeKey({ ats: k.ats, atsJobId: k.atsJobId, url: k.url }),
    ),
  );
  const kept: Candidate[] = [];
  const dropped: Candidate[] = [];
  for (const c of candidates) (keys.has(dedupeKey(c)) ? dropped : kept).push(c);
  return { kept, dropped };
}
