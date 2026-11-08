import { and, asc, desc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import {
  applications,
  captchaRequests,
  companies,
  interviewSlots,
  interviews,
  jobs,
} from '../schema';
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

export interface WaitingOnUser {
  /** Applications with a CAPTCHA the agent could not solve and a still-valid link for the user. */
  captcha: Set<string>;
  /** Applications whose interview has slot links offered and none confirmed yet. */
  pickTime: Set<string>;
}

/**
 * Applications that cannot move until the user acts. Both queries are tenant- and user-scoped and
 * count only requests still open: a resolved, expired or invalidated one is not waiting on anyone.
 */
export async function listWaitingOnUser(
  handle: TenantHandle,
  userId: string,
): Promise<WaitingOnUser> {
  const [captcha, pickTime] = await Promise.all([
    handle.run((tx) =>
      tx
        .selectDistinct({ id: captchaRequests.applicationId })
        .from(captchaRequests)
        .where(
          and(
            eq(captchaRequests.tenantId, handle.tenantId),
            eq(captchaRequests.userId, userId),
            eq(captchaRequests.stage, 'human'),
            isNull(captchaRequests.resolvedAt),
            isNull(captchaRequests.expiredAt),
            or(isNull(captchaRequests.expiresAt), gt(captchaRequests.expiresAt, sql`now()`)),
          ),
        ),
    ),
    handle.run((tx) =>
      tx
        .selectDistinct({ id: interviews.applicationId })
        .from(interviews)
        .innerJoin(
          interviewSlots,
          and(
            eq(interviewSlots.tenantId, interviews.tenantId),
            eq(interviewSlots.interviewId, interviews.id),
          ),
        )
        .where(
          and(
            eq(interviews.tenantId, handle.tenantId),
            eq(interviews.userId, userId),
            isNull(interviews.confirmedSlotId),
            isNull(interviewSlots.invalidatedAt),
            isNull(interviewSlots.confirmedAt),
            gt(interviewSlots.expiresAt, sql`now()`),
          ),
        ),
    ),
  ]);
  return {
    captcha: new Set(captcha.map((r) => r.id)),
    pickTime: new Set(pickTime.map((r) => r.id)),
  };
}
