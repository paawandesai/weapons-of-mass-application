import { and, eq, inArray, or } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { jobs } from '../schema';
import type { AtsKind } from './companies';

export type JobRow = typeof jobs.$inferSelect;

export interface JobInput {
  companyId?: string | null;
  ats?: AtsKind | null;
  atsJobId?: string | null;
  title: string;
  url: string;
  description?: string | null;
  location?: string | null;
  locationMode?: string | null;
  payMin?: number | null;
  payMax?: number | null;
  currency?: string | null;
  postedAt?: Date | null;
  raw?: unknown;
}

export async function getJob(handle: TenantHandle, id: string): Promise<JobRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, handle.tenantId), eq(jobs.id, id))),
  );
  return rows[0] ?? null;
}

export function listJobsByIds(handle: TenantHandle, ids: string[]): Promise<JobRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return handle.run((tx) =>
    tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, handle.tenantId), inArray(jobs.id, ids))),
  );
}

/** Finds a job by (ats, ats_job_id) when both are given, or by its normalized url. */
export async function findJob(
  handle: TenantHandle,
  key: { ats?: AtsKind | null; atsJobId?: string | null; url: string },
): Promise<JobRow | null> {
  const byUrl = eq(jobs.url, key.url);
  const where =
    key.ats && key.atsJobId
      ? or(and(eq(jobs.ats, key.ats), eq(jobs.atsJobId, key.atsJobId)), byUrl)
      : byUrl;
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, handle.tenantId), where))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Writes the job once per (tenant, ats, ats_job_id) or (tenant, url); an existing job is returned
 * unchanged with `created: false` (jobs are immutable after hand-off).
 */
export async function upsertJob(
  handle: TenantHandle,
  input: JobInput,
): Promise<{ job: JobRow; created: boolean }> {
  const inserted = await handle.run((tx) =>
    tx
      .insert(jobs)
      .values({
        tenantId: handle.tenantId,
        companyId: input.companyId ?? null,
        ats: input.ats ?? null,
        atsJobId: input.atsJobId ?? null,
        title: input.title,
        url: input.url,
        description: input.description ?? null,
        location: input.location ?? null,
        locationMode: input.locationMode ?? null,
        payMin: input.payMin ?? null,
        payMax: input.payMax ?? null,
        currency: input.currency ?? null,
        postedAt: input.postedAt ?? null,
        raw: input.raw ?? null,
      })
      .onConflictDoNothing()
      .returning(),
  );
  if (inserted[0]) return { job: inserted[0], created: true };
  const existing = await findJob(handle, input);
  if (!existing) throw new Error('job insert conflicted but no matching job exists');
  return { job: existing, created: false };
}
