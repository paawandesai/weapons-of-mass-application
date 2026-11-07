import { and, eq } from 'drizzle-orm';
import { schema, type TenantHandle } from '@wma/db';
import type { Candidate } from '@wma/shared';
import type { SourceAdapter } from '../types';

/**
 * The demo tenant's own postings: the jobs the seed created, served as candidates so a live daily
 * run finds them, judges them and applies through the fixture forms. It is registered only for a
 * tenant flagged `demo` (see `adaptersFor`), and reads only that tenant's rows.
 */
export function createSeededAdapter(handle: TenantHandle): SourceAdapter {
  return {
    id: 'seeded',
    async fetch() {
      const rows = await handle.run((tx) =>
        tx
          .select({ job: schema.jobs, company: schema.companies })
          .from(schema.jobs)
          .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
          .where(and(eq(schema.jobs.tenantId, handle.tenantId), eq(schema.jobs.seeded, true))),
      );
      const candidates: Candidate[] = rows.flatMap(({ job, company }) =>
        job.ats && company
          ? [
              {
                // Reported under the vendor of the form it will be submitted through.
                source: job.ats,
                title: job.title,
                companyName: company.name,
                companyId: company.id,
                url: job.url,
                ats: job.ats,
                atsJobId: job.atsJobId,
                description: job.description,
                location: job.location,
                postedAt: job.postedAt ? job.postedAt.toISOString() : null,
              },
            ]
          : [],
      );
      return { status: 'ok', candidates };
    },
  };
}
