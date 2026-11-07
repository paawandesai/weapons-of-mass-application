import type { TenantHandle } from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import type { MailDeps, ProposedSlot } from '@wma/shared';
import type { InboxGmailPort } from './gmail-reader';
import type { DigestFlag } from './flags';

export interface OfferSlotsInput {
  userId: string;
  applicationId: string;
  /** `email_threads.id` of the recruiter thread. */
  threadId: string;
  /** Gmail id of the message that proposed the slots. */
  messageId: string;
  slots: ProposedSlot[];
  /** The message also asked about or stated compensation: the reply template must carry no money text. */
  compensationFlag: boolean;
}

/** An offer whose slots are committed and whose confirmation email is still to be sent. */
export interface OfferToSend {
  interviewId: string;
  /** Opaque to the inbox: scheduling's issued slot tokens. */
  issued: unknown;
}

export interface InboxClock {
  now(): Date;
}

/** Everything the inbox sync and the follow-up job take from outside; tests inject fakes. */
export interface InboxDeps {
  gmail(handle: TenantHandle, userId: string): InboxGmailPort;
  llm: StructuredLlm;
  /** The only mail path: deps for `sendEmail` bound to this handle and user. */
  mail(handle: TenantHandle, userId: string): MailDeps;
  /**
   * Scheduling's `recordOffer`: stores the interview and slots inside the caller's transaction and
   * sends nothing. `send` is set only when a confirmation request is now owed; it carries the
   * freshly issued tokens, which exist nowhere else. Throws CalendarUnavailableError when the
   * calendar cannot be read.
   */
  recordOffer(handle: TenantHandle, input: OfferSlotsInput): Promise<{ send: OfferToSend | null }>;
  /** Scheduling's `sendOfferEmail`: sends the confirmation request after the slots committed. */
  sendOfferEmail(handle: TenantHandle, userId: string, offer: OfferToSend): Promise<unknown>;
  /** Re-sends confirmation requests whose email never recorded as sent (scheduling). */
  resendPendingConfirmations(handle: TenantHandle, userId: string): Promise<unknown>;
  /** Re-enqueues booking for confirmed interviews whose reply or event is not recorded (scheduling). */
  requeueUnbookedInterviews(handle: TenantHandle, userId: string): Promise<unknown>;
  flagDigest(handle: TenantHandle, flag: DigestFlag): Promise<void>;
  clock: InboxClock;
}

export const systemInboxClock: InboxClock = { now: () => new Date() };
