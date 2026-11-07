import { and, asc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { interviews } from '../schema';
import type { InterviewRow } from './interviews';

/** Interviews whose slots were stored but whose confirmation request email was never recorded as sent. */
export function listInterviewsAwaitingConfirmationEmail(
  handle: TenantHandle,
  userId: string,
): Promise<InterviewRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(
        and(
          eq(interviews.tenantId, handle.tenantId),
          eq(interviews.userId, userId),
          isNull(interviews.confirmationEmailSentAt),
          isNull(interviews.confirmedSlotId),
        ),
      )
      .orderBy(asc(interviews.createdAt), asc(interviews.id)),
  );
}

/**
 * Confirmed interviews whose booking has not completed for the CURRENT confirmed-slot generation:
 * the recruiter reply is not recorded, or the Calendar write for this generation has not
 * finished (`booked_generation` differs from `confirmed_generation`). A retained event id from an
 * earlier time does not count as completion. Slots that have already started (database clock)
 * are not requeued.
 */
export function listInterviewsAwaitingBooking(
  handle: TenantHandle,
  userId: string,
): Promise<InterviewRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(
        and(
          eq(interviews.tenantId, handle.tenantId),
          eq(interviews.userId, userId),
          isNotNull(interviews.confirmedSlotId),
          gt(interviews.startsAt, sql`now()`),
          or(
            isNull(interviews.replySentAt),
            isNull(interviews.bookedGeneration),
            sql`${interviews.bookedGeneration} <> ${interviews.confirmedGeneration}`,
          ),
        ),
      )
      .orderBy(asc(interviews.createdAt), asc(interviews.id)),
  );
}

/** Confirmed, future interviews (any booking state): reminders are scheduled for these at confirmation. */
export function listConfirmedFutureInterviews(
  handle: TenantHandle,
  userId: string,
): Promise<InterviewRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(interviews)
      .where(
        and(
          eq(interviews.tenantId, handle.tenantId),
          eq(interviews.userId, userId),
          isNotNull(interviews.confirmedSlotId),
          gt(interviews.startsAt, sql`now()`),
        ),
      )
      .orderBy(asc(interviews.startsAt), asc(interviews.id)),
  );
}
