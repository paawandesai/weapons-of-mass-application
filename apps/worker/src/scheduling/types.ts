import type { TenantHandle } from '@wma/db';
import type { MailDeps, ProposedSlot } from '@wma/shared';

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CalendarEventInput {
  /** Client-generated event id. On create it makes the call get-or-create: the same id never yields a second event. */
  id?: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
}

/** The user's calendar. The Google implementation is `createCalendarPort`; tests use a fake. */
export interface CalendarPort {
  /** Busy intervals overlapping [from, to) on the user's primary calendar. Throws when it cannot be read. */
  busy(from: Date, to: Date): Promise<BusyInterval[]>;
  createEvent(event: CalendarEventInput): Promise<{ id: string }>;
  updateEvent(id: string, event: CalendarEventInput): Promise<void>;
}

export interface ReplyContext {
  /** Recruiter address to answer. */
  to: string;
  /** Subject to reply under (already prefixed with "Re:" where needed). */
  subject: string;
  /** The recruiter's name when the message shows one (used as the interviewer). */
  fromName: string | null;
  /** RFC 5322 Message-ID of the recruiter's latest message. */
  inReplyTo?: string;
  references?: string;
}

/** Reads the recruiter thread so the acceptance can be sent on it. */
export interface MailboxPort {
  replyContext(gmailThreadId: string, selfEmail: string): Promise<ReplyContext>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Per-tenant, per-user collaborators; production builds them from the user's Google connection. */
export interface SchedulingDeps {
  clock: Clock;
  calendar: CalendarPort;
  mailbox: MailboxPort;
  mail: MailDeps;
  /** Base of the confirmation links, for example `https://app.example.com`. */
  webOrigin: string;
  /** Provided by the notifications workstream: schedules T-24h and T-1h reminders for a confirmed interview. */
  scheduleReminders: (handle: TenantHandle, interviewId: string) => Promise<void>;
  /** Test seam for token bytes; defaults to 32 random bytes. */
  randomBytes?: (n: number) => Buffer;
}

export interface OfferInput {
  userId: string;
  applicationId: string;
  /** `email_threads.id` of the recruiter thread. */
  threadId: string;
  /** Gmail id of the message that proposed the times (recorded in the activity log). */
  messageId: string;
  slots: ProposedSlot[];
  compensationFlag: boolean;
}

/** A slot just stored, with its raw single-use token. The token lives only in memory and in the email. */
export interface IssuedSlot {
  slotId: string;
  start: Date;
  end: Date;
  token: string;
}

/** What `recordOffer` returns: the result plus the tokens `sendOfferEmail` needs. */
export interface RecordedOffer extends OfferResult {
  issued: IssuedSlot[];
}

export interface OfferResult {
  status: 'offered' | 'no_slots' | 'no_free_slot' | 'already_offered' | 'blocked';
  interviewId: string | null;
  /** True when this offer replaced a confirmed interview's time (rule 11). */
  reschedule: boolean;
  offered: number;
  /** Why options were dropped, one line each (ambiguous, past, conflicting). */
  notes: string[];
}
