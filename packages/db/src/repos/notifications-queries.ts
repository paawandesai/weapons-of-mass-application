import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import {
  activityLog,
  applications,
  captchaRequests,
  companies,
  digestState,
  emailThreads,
  interviewSlots,
  interviews,
  jobs,
  outgoingMessages,
} from '../schema';

/** When the user's last digest was actually sent (blocked attempts do not count); null if never. */
export async function lastDigestSentAt(handle: TenantHandle, userId: string): Promise<Date | null> {
  const rows = await handle.run((tx) =>
    tx
      .select({ sentAt: outgoingMessages.sentAt })
      .from(outgoingMessages)
      .where(
        and(
          eq(outgoingMessages.tenantId, handle.tenantId),
          eq(outgoingMessages.userId, userId),
          eq(outgoingMessages.kind, 'digest'),
          eq(outgoingMessages.blocked, false),
          sql`${outgoingMessages.sentAt} is not null`,
        ),
      )
      .orderBy(desc(outgoingMessages.sentAt))
      .limit(1),
  );
  return rows[0]?.sentAt ?? null;
}

export interface ApplicationLabel {
  applicationId: string;
  companyName: string;
  jobTitle: string;
}

/** Company name and job title for each application id, for user-facing text. */
export async function listApplicationLabels(
  handle: TenantHandle,
  applicationIds: string[],
): Promise<Map<string, ApplicationLabel>> {
  const out = new Map<string, ApplicationLabel>();
  if (applicationIds.length === 0) return out;
  const rows = await handle.run((tx) =>
    tx
      .select({
        applicationId: applications.id,
        companyName: companies.name,
        jobTitle: jobs.title,
      })
      .from(applications)
      .innerJoin(
        jobs,
        and(eq(jobs.tenantId, applications.tenantId), eq(jobs.id, applications.jobId)),
      )
      .leftJoin(companies, eq(companies.id, jobs.companyId))
      .where(
        and(
          eq(applications.tenantId, handle.tenantId),
          inArray(applications.id, [...new Set(applicationIds)]),
        ),
      ),
  );
  for (const r of rows) {
    out.set(r.applicationId, {
      applicationId: r.applicationId,
      companyName: r.companyName ?? 'the company',
      jobTitle: r.jobTitle,
    });
  }
  return out;
}

export interface AwaitingConfirmation {
  interviewId: string;
  applicationId: string;
  slots: Array<{ startsAt: Date; endsAt: Date }>;
}

/** Interviews with no confirmed slot that still have at least one usable token (database clock). */
export async function listAwaitingConfirmation(
  handle: TenantHandle,
  userId: string,
): Promise<AwaitingConfirmation[]> {
  const rows = await handle.run((tx) =>
    tx
      .select({
        interviewId: interviews.id,
        applicationId: interviews.applicationId,
        startsAt: interviewSlots.startsAt,
        endsAt: interviewSlots.endsAt,
      })
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
          sql`${interviewSlots.expiresAt} > now()`,
        ),
      )
      .orderBy(asc(interviews.createdAt), asc(interviews.id), asc(interviewSlots.startsAt)),
  );
  const byInterview = new Map<string, AwaitingConfirmation>();
  for (const r of rows) {
    let e = byInterview.get(r.interviewId);
    if (!e) {
      e = { interviewId: r.interviewId, applicationId: r.applicationId, slots: [] };
      byInterview.set(r.interviewId, e);
    }
    e.slots.push({ startsAt: r.startsAt, endsAt: r.endsAt });
  }
  return [...byInterview.values()];
}

export interface PendingHumanCaptcha {
  id: string;
  applicationId: string;
  expiresAt: Date | null;
}

/** CAPTCHA requests waiting on the user: stage human, unresolved, not expired. */
export async function listPendingHumanCaptchas(
  handle: TenantHandle,
  userId: string,
  now: Date,
): Promise<PendingHumanCaptcha[]> {
  return handle.run((tx) =>
    tx
      .select({
        id: captchaRequests.id,
        applicationId: captchaRequests.applicationId,
        expiresAt: captchaRequests.expiresAt,
      })
      .from(captchaRequests)
      .where(
        and(
          eq(captchaRequests.tenantId, handle.tenantId),
          eq(captchaRequests.userId, userId),
          eq(captchaRequests.stage, 'human'),
          isNull(captchaRequests.resolvedAt),
          isNull(captchaRequests.expiredAt),
          or(isNull(captchaRequests.expiresAt), sql`${captchaRequests.expiresAt} > ${now}`),
        ),
      )
      .orderBy(asc(captchaRequests.createdAt), asc(captchaRequests.id)),
  );
}

/** True when the user has an activity row with this action whose detail[key] equals value. */
export async function hasActivityWithDetail(
  handle: TenantHandle,
  userId: string,
  action: string,
  key: string,
  value: string,
): Promise<boolean> {
  const rows = await handle.run((tx) =>
    tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.tenantId, handle.tenantId),
          eq(activityLog.userId, userId),
          eq(activityLog.action, action),
          sql`${activityLog.detail} ->> ${key} = ${value}`,
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

/** The instant up to which the user's activity was already covered by a digest; null before the first. */
export async function getDigestCheckpoint(
  handle: TenantHandle,
  userId: string,
): Promise<Date | null> {
  const rows = await handle.run((tx) =>
    tx
      .select({ at: digestState.collectedThrough })
      .from(digestState)
      .where(and(eq(digestState.tenantId, handle.tenantId), eq(digestState.userId, userId))),
  );
  return rows[0]?.at ?? null;
}

/**
 * Stores the collection cutoff of a digest that went out. It only moves forward: a late retry of
 * an older digest never rewinds it.
 */
export async function setDigestCheckpoint(
  handle: TenantHandle,
  userId: string,
  at: Date,
): Promise<void> {
  await handle.run((tx) =>
    tx
      .insert(digestState)
      .values({ tenantId: handle.tenantId, userId, collectedThrough: at })
      .onConflictDoUpdate({
        target: [digestState.tenantId, digestState.userId],
        set: {
          collectedThrough: sql`greatest(${digestState.collectedThrough}, excluded.collected_through)`,
        },
      }),
  );
}

export interface FlaggedThread {
  threadId: string;
  applicationId: string;
  compensationFlag: boolean;
  bookingLink: string | null;
}

/**
 * Threads of open applications that still carry a pay flag or an unused scheduling link. They
 * appear in every digest while the application is open, not only the one after the message.
 */
export function listFlaggedThreads(handle: TenantHandle, userId: string): Promise<FlaggedThread[]> {
  return handle
    .run((tx) =>
      tx
        .select({
          threadId: emailThreads.id,
          applicationId: emailThreads.applicationId,
          compensationFlag: emailThreads.compensationFlag,
          bookingLink: emailThreads.bookingLink,
        })
        .from(emailThreads)
        .innerJoin(
          applications,
          and(
            eq(applications.tenantId, emailThreads.tenantId),
            eq(applications.id, emailThreads.applicationId),
          ),
        )
        .where(
          and(
            eq(emailThreads.tenantId, handle.tenantId),
            eq(emailThreads.userId, userId),
            ne(applications.status, 'closed'),
            or(
              eq(emailThreads.compensationFlag, true),
              sql`${emailThreads.bookingLink} is not null`,
            ),
          ),
        )
        .orderBy(asc(emailThreads.lastMessageAt), asc(emailThreads.id)),
    )
    .then((rows) =>
      rows.flatMap((r) => (r.applicationId ? [{ ...r, applicationId: r.applicationId }] : [])),
    );
}
