import { and, asc, desc, eq, ilike } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { applications, companies, jobs } from '../schema';
import type { ApplicationRow } from './applications';
import type { JobRow } from './jobs';

export interface CompanySearchRow {
  application: ApplicationRow;
  job: JobRow;
  company: string;
}

/** `%`, `_` and the escape character are literal in a user's search text. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Case-insensitive substring match over the company names of one user's applications. The
 * tenant and user predicate, the name filter, the order and the limit all run in the database,
 * so only the matching rows leave it.
 */
export function searchApplicationsByCompany(
  handle: TenantHandle,
  userId: string,
  query: string,
  limit: number,
): Promise<CompanySearchRow[]> {
  return handle
    .run((tx) =>
      tx
        .select({ application: applications, job: jobs, company: companies.name })
        .from(applications)
        .innerJoin(
          jobs,
          and(eq(jobs.tenantId, applications.tenantId), eq(jobs.id, applications.jobId)),
        )
        .innerJoin(companies, eq(companies.id, jobs.companyId))
        .where(
          and(
            eq(applications.tenantId, handle.tenantId),
            eq(applications.userId, userId),
            ilike(companies.name, `%${escapeLike(query)}%`),
          ),
        )
        .orderBy(asc(companies.name), desc(applications.lastActivityAt), asc(applications.id))
        .limit(limit),
    )
    .then((rows) => rows as CompanySearchRow[]);
}
