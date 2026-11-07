import { createHash, randomBytes } from 'node:crypto';
import {
  activity,
  getApplication,
  getCompany,
  getInterview,
  getInterviewByThread,
  getJob,
  getUserById,
  clearConfirmationForReschedule,
  insertInterview,
  insertInterviewSlot,
  invalidateOpenSlots,
  listInterviewsAwaitingConfirmationEmail,
  lockInterview,
  listSlotsForInterview,
  updateInterview,
  type InterviewRow,
  type TenantHandle,
  type User,
} from '@wma/db';
import { sendEmail } from '@wma/shared';
import { isGoogleAuthError } from './auth';
import { normalizeSlots, overlaps, type NormalizedSlot } from './slots';
import { confirmationEmail } from './templates';
import type { IssuedSlot, OfferInput, OfferResult, RecordedOffer, SchedulingDeps } from './types';

export class CalendarUnavailableError extends Error {
  readonly code = 'calendar_unavailable' as const;
  constructor() {
    super('the calendar could not be read; conflict filtering will be retried');
    this.name = 'CalendarUnavailableError';
  }
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

const MONEY_WORD = /salary|compensation|equity/i;

/** 32 random bytes as base64url; re-drawn in the (astronomically unlikely) case it spells a blocked word. */
function newToken(deps: SchedulingDeps): string {
  const bytes = deps.randomBytes ?? randomBytes;
  for (;;) {
    const t = bytes(32).toString('base64url');
    if (!MONEY_WORD.test(t)) return t;
  }
}

export interface ApplicationContext {
  user: User;
  applicationId: string;
  companyName: string;
  jobTitle: string;
}

export async function loadApplicationContext(
  handle: TenantHandle,
  userId: string,
  applicationId: string,
): Promise<ApplicationContext> {
  const [user, application] = await Promise.all([
    getUserById(handle, userId),
    getApplication(handle, applicationId),
  ]);
  if (!application) throw new Error('application not found');
  const job = await getJob(handle, application.jobId);
  const company = job?.companyId ? await getCompany(handle, job.companyId) : null;
  return {
    user,
    applicationId,
    companyName: company?.name ?? 'the company',
    jobTitle: job?.title ?? 'the role',
  };
}

/** Removes slots that overlap a busy interval. Throws CalendarUnavailableError when the calendar cannot be read. */
async function filterConflicts(
  handle: TenantHandle,
  ctx: ApplicationContext,
  slots: NormalizedSlot[],
  deps: SchedulingDeps,
  where: { threadId: string },
): Promise<{ free: NormalizedSlot[]; conflicts: NormalizedSlot[] }> {
  if (slots.length === 0) return { free: [], conflicts: [] };
  const from = new Date(Math.min(...slots.map((s) => s.start.getTime())));
  const to = new Date(Math.max(...slots.map((s) => s.end.getTime())));
  let busy;
  try {
    busy = await deps.calendar.busy(from, to);
  } catch (e) {
    // A revoked or missing grant is not "calendar down": the caller must see the original error
    // so the connection is marked revoked instead of the work being deferred forever.
    if (isGoogleAuthError(e)) throw e;
    await activity.logActivity(handle, {
      userId: ctx.user.id,
      applicationId: ctx.applicationId,
      actor: 'agent',
      action: 'calendar_read_failed',
      detail: { thread_id: where.threadId, error: e instanceof Error ? e.name : 'error' },
    });
    throw new CalendarUnavailableError();
  }
  const free: NormalizedSlot[] = [];
  const conflicts: NormalizedSlot[] = [];
  for (const s of slots) (busy.some((b) => overlaps(s, b)) ? conflicts : free).push(s);
  return { free, conflicts };
}

async function flagNoFreeSlot(
  handle: TenantHandle,
  ctx: ApplicationContext,
  detail: Record<string, unknown>,
): Promise<void> {
  await activity.logActivity(handle, {
    userId: ctx.user.id,
    applicationId: ctx.applicationId,
    actor: 'agent',
    action: 'digest_flag',
    detail: { kind: 'no_free_slot', ...detail },
  });
}

const iso = (s: NormalizedSlot) => ({ start: s.start.toISOString(), end: s.end.toISOString() });

/**
 * Replaces every still-open slot of the interview with fresh slots and single-use tokens, inside
 * the caller's transaction. A reschedule clears the confirmation (and bumps the generation so a
 * booking in flight for the old time fails its writes); the existing Calendar event is kept.
 * Returns the raw tokens: they exist only in memory and in the email.
 */
async function writeSlots(
  handle: TenantHandle,
  interview: InterviewRow,
  free: NormalizedSlot[],
  deps: SchedulingDeps,
  reschedule: boolean,
  repair = false,
): Promise<IssuedSlot[]> {
  const issued: IssuedSlot[] = [];
  await handle.transaction(async (h) => {
    // Lock the row first so this waits for a booking that holds it.
    const locked = (await lockInterview(h, interview.id)) ?? interview;
    // A repair never undoes a confirmation that landed since it looked.
    if (repair && locked.confirmedSlotId != null) return;
    await invalidateOpenSlots(h, interview.id);
    // Decide from the locked row: a confirmation may have landed since the caller read it.
    if (reschedule || locked.confirmedSlotId != null) {
      await clearConfirmationForReschedule(h, interview.id);
    } else if (locked.confirmationEmailSentAt) {
      await updateInterview(h, interview.id, { confirmationEmailSentAt: null });
    }
    for (const slot of free) {
      const token = newToken(deps);
      const row = await insertInterviewSlot(h, {
        interviewId: interview.id,
        startsAt: slot.start,
        endsAt: slot.end,
        tzHint: slot.tzHint,
        tokenHash: sha256Hex(token),
      });
      issued.push({ slotId: row.id, start: slot.start, end: slot.end, token });
    }
  });
  return issued;
}

/**
 * Design rule 8 (and 11 when the interview is already confirmed), first half. Drops ambiguous
 * and past options with notes, removes calendar conflicts, then either flags `no_free_slot` or
 * stores the interview, its slots and their token hashes, all inside the CALLER'S transaction
 * (so it commits or rolls back with the message that proposed the times). Nothing is emailed:
 * call `sendOfferEmail` after that transaction commits, using the returned `issued` tokens.
 * The recruiter is never written to here. Throws CalendarUnavailableError when the calendar
 * cannot be read, and rethrows Google authentication errors untouched.
 */
export async function recordOffer(
  handle: TenantHandle,
  input: OfferInput,
  deps: SchedulingDeps,
): Promise<RecordedOffer> {
  const none = (
    status: OfferResult['status'],
    extra: Partial<OfferResult> = {},
  ): RecordedOffer => ({
    status,
    interviewId: null,
    reschedule: false,
    offered: 0,
    notes: [],
    issued: [],
    ...extra,
  });
  if (input.slots.length === 0) return none('no_slots');

  const ctx = await loadApplicationContext(handle, input.userId, input.applicationId);
  const now = deps.clock.now();
  const { slots, notes } = normalizeSlots(input.slots, now, ctx.user.timezone);
  const base = { thread_id: input.threadId, message_id: input.messageId };

  const existing = await getInterviewByThread(handle, input.threadId);
  const reschedule = existing?.confirmedSlotId != null;

  // The same times offered again while their request is out: nothing to do.
  if (existing && !reschedule && existing.confirmationEmailSentAt && slots.length > 0) {
    const open = (await listSlotsForInterview(handle, existing.id)).filter(
      (s) => !s.invalidatedAt && !s.confirmedAt && s.expiresAt > now,
    );
    const have = open.map((s) => s.startsAt.getTime()).sort();
    const want = slots.map((s) => s.start.getTime()).sort();
    if (have.length === want.length && have.every((t, i) => t === want[i])) {
      return none('already_offered', { interviewId: existing.id, notes });
    }
  }

  const { free, conflicts } = await filterConflicts(handle, ctx, slots, deps, {
    threadId: input.threadId,
  });
  if (conflicts.length > 0) {
    notes.push(
      ...conflicts.map((c) => `Dropped ${c.start.toISOString()}: overlaps a calendar event.`),
    );
  }
  if (free.length === 0) {
    await flagNoFreeSlot(handle, ctx, {
      ...base,
      reason: conflicts.length > 0 ? 'calendar_conflict' : 'no_usable_option',
      conflicts: conflicts.map(iso),
      notes,
    });
    return none('no_free_slot', { notes });
  }

  const { interview } = await insertInterview(handle, {
    userId: input.userId,
    applicationId: input.applicationId,
    threadId: input.threadId,
  });
  const issued = await writeSlots(handle, interview, free, deps, reschedule);
  await activity.logActivity(handle, {
    userId: input.userId,
    applicationId: input.applicationId,
    actor: 'agent',
    action: 'slots_offered',
    detail: {
      ...base,
      interview_id: interview.id,
      count: free.length,
      slots: free.map(iso),
      notes,
      reschedule,
      compensation_flag: input.compensationFlag,
    },
  });
  return {
    status: 'offered',
    interviewId: interview.id,
    reschedule,
    offered: free.length,
    notes,
    issued,
  };
}

/**
 * Second half: sends the ONE confirmation request for an interview whose slots are stored, and
 * records `confirmation_email_sent_at`. Call it after the transaction that ran `recordOffer`
 * committed, passing its `issued` tokens. Without `issued` (the repair pass: tokens exist only in
 * the email, so a lost one cannot be recovered) the still-open future slots are replaced with
 * fresh ones first. A crash before this completes leaves `confirmation_email_sent_at` null and
 * `resendPendingConfirmations` repairs it. Never throws for a blocked message.
 */
export async function sendOfferEmail(
  handle: TenantHandle,
  interviewId: string,
  deps: SchedulingDeps,
  issued?: IssuedSlot[],
): Promise<'sent' | 'blocked' | 'nothing_to_send'> {
  const interview = await getInterview(handle, interviewId);
  if (!interview || interview.confirmedSlotId) return 'nothing_to_send';
  const ctx = await loadApplicationContext(handle, interview.userId, interview.applicationId);

  let options = issued;
  if (!options) {
    const now = deps.clock.now();
    const open = (await listSlotsForInterview(handle, interview.id)).filter(
      (s) => !s.invalidatedAt && !s.confirmedAt && s.expiresAt > now && s.startsAt > now,
    );
    if (open.length === 0) return 'nothing_to_send';
    options = await writeSlots(
      handle,
      interview,
      open.map((s) => ({ start: s.startsAt, end: s.endsAt, tzHint: s.tzHint })),
      deps,
      false,
      true,
    );
  }
  if (options.length === 0) return 'nothing_to_send';

  const origin = deps.webOrigin.replace(/\/+$/, '');
  const result = await sendEmail(deps.mail, {
    ...confirmationEmail({
      userId: ctx.user.id,
      applicationId: ctx.applicationId,
      to: ctx.user.email,
      companyName: ctx.companyName,
      jobTitle: ctx.jobTitle,
      zone: ctx.user.timezone,
      options: options.map((o) => ({
        start: o.start,
        end: o.end,
        link: `${origin}/confirm/${o.token}`,
      })),
    }),
    deliveryKey: `slot_confirmation:${interview.id}:${options[0]!.slotId}`,
  });
  if (result.status === 'blocked') return 'blocked';
  // An uncertain earlier attempt for these very slots is not repeated; the user may already have
  // the request. Only a send we know happened marks the interview as asked.
  if (result.status === 'uncertain') return 'nothing_to_send';
  await updateInterview(handle, interview.id, { confirmationEmailSentAt: deps.clock.now() });
  return 'sent';
}

/**
 * `recordOffer` then `sendOfferEmail` in one call, for callers that do not hold a transaction.
 * The inbox sync uses the two halves so the email goes out after its message transaction commits.
 */
export async function offerSlots(
  handle: TenantHandle,
  input: OfferInput,
  deps: SchedulingDeps,
): Promise<OfferResult> {
  const recorded = await recordOffer(handle, input, deps);
  const { issued, ...result } = recorded;
  if (result.status !== 'offered' || !result.interviewId) return result;
  const sent = await sendOfferEmail(handle, result.interviewId, deps, issued);
  return sent === 'blocked' ? { ...result, status: 'blocked' } : result;
}

/**
 * Repairs the crash gap: interviews whose slots were stored but whose confirmation request never
 * recorded as sent. Each pass re-checks the calendar for the still-open future times, replaces
 * their tokens with fresh ones and sends the request once. Returns how many requests were sent.
 * A failure on one interview does not stop the others, except an authentication error, which is
 * rethrown so the caller can mark the connection revoked.
 */
export async function resendPendingConfirmations(
  handle: TenantHandle,
  userId: string,
  deps: SchedulingDeps,
): Promise<number> {
  const now = deps.clock.now();
  let sent = 0;
  for (const interview of await listInterviewsAwaitingConfirmationEmail(handle, userId)) {
    try {
      const open = (await listSlotsForInterview(handle, interview.id)).filter(
        (s) => !s.invalidatedAt && !s.confirmedAt && s.expiresAt > now && s.startsAt > now,
      );
      if (open.length === 0) continue;
      const ctx = await loadApplicationContext(handle, userId, interview.applicationId);
      const slots: NormalizedSlot[] = open.map((s) => ({
        start: s.startsAt,
        end: s.endsAt,
        tzHint: s.tzHint,
      }));
      const { free, conflicts } = await filterConflicts(handle, ctx, slots, deps, {
        threadId: interview.threadId,
      });
      if (free.length === 0) {
        await invalidateOpenSlots(handle, interview.id);
        await flagNoFreeSlot(handle, ctx, {
          thread_id: interview.threadId,
          reason: 'calendar_conflict',
          conflicts: conflicts.map(iso),
        });
        continue;
      }
      // Drop the conflicting options, then rotate the tokens of the rest and send.
      if (conflicts.length > 0) {
        const issued = await writeSlots(handle, interview, free, deps, false, true);
        if ((await sendOfferEmail(handle, interview.id, deps, issued)) !== 'sent') continue;
      } else if ((await sendOfferEmail(handle, interview.id, deps)) !== 'sent') {
        continue;
      }
      sent++;
      await activity.logActivity(handle, {
        userId,
        applicationId: interview.applicationId,
        actor: 'agent',
        action: 'slots_offered',
        detail: { interview_id: interview.id, count: free.length, resent: true },
      });
    } catch (e) {
      if (isGoogleAuthError(e)) throw e;
      // stays pending; the next pass tries again
    }
  }
  return sent;
}
