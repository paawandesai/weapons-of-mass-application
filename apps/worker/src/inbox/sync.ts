import {
  activity,
  getApplication,
  getEmailThreadByGmailId,
  getMailSyncState,
  applyTransition,
  getUserById,
  isMessageProcessed,
  listApplications,
  listProcessedMessageIds,
  markMessageProcessed,
  updateApplication,
  upsertEmailThread,
  upsertMailSyncState,
  type TenantHandle,
  recordFollowOnJob,
} from '@wma/db';
import { markRevoked } from '@wma/google';
import { negotiationKey, NEGOTIATION_JOB, type ProposedSlot } from '@wma/shared';
import { CalendarUnavailableError } from '../scheduling/offer';
import { classifyMessage } from './classify';
import type { InboxDeps, OfferToSend } from './deps';
import { isAuthError, type InboxMessage } from './gmail-reader';
import { linkMessage, loadCandidates } from './link';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_INBOUND_LABELS = ['SENT', 'DRAFT'];

export type MessageOutcome = 'linked' | 'unlinked' | 'failed' | 'duplicate' | 'deferred';

export type SyncResult =
  | {
      status: 'ok';
      mode: 'history' | 'dated';
      messages: number;
      linked: number;
      unlinked: number;
      failed: number;
      /** Left unprocessed because the calendar could not be read; retried by id next run. */
      deferred: number;
      duplicates: number;
      historyId: string;
    }
  | { status: 'reauth_needed' };

class AlreadyProcessed extends Error {}

const senderOf = (from: string) => /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from.trim();

/**
 * Rules 1 and 17. Reads the new inbox messages (history list from the stored high-water mark, or
 * the dated message list when there is none or it has expired), processes each message in its own
 * transaction, and only then advances the mark. A rejected credential marks the mailbox for
 * re-authorization and returns without throwing; any other Gmail error propagates so the queue
 * retries the job with the mark unchanged.
 */
export async function runMailSync(
  handle: TenantHandle,
  userId: string,
  deps: InboxDeps,
): Promise<SyncResult> {
  try {
    return await sync(handle, userId, deps);
  } catch (e) {
    if (!isAuthError(e)) throw e;
    const state = await getMailSyncState(handle, userId);
    if (!state?.reauthNeeded) {
      await markRevoked(handle, userId);
      await activity.logActivity(handle, {
        userId,
        actor: 'agent',
        action: 'mailbox_reauth_needed',
        detail: { job: 'mail-sync' },
      });
    }
    await upsertMailSyncState(handle, userId, { reauthNeeded: true });
    return { status: 'reauth_needed' };
  }
}

async function fallbackStart(
  handle: TenantHandle,
  userId: string,
  lastSyncedAt: Date | null | undefined,
): Promise<Date | null> {
  let base = lastSyncedAt ?? null;
  if (!base) {
    const times = (await listApplications(handle, userId)).map((a) =>
      (a.appliedAt ?? a.createdAt).getTime(),
    );
    if (times.length === 0) return null;
    base = new Date(Math.min(...times));
  }
  // One day of overlap; processed_messages makes the repeat harmless.
  return new Date(base.getTime() - DAY_MS);
}

async function sync(handle: TenantHandle, userId: string, deps: InboxDeps): Promise<SyncResult> {
  const gmail = deps.gmail(handle, userId);
  const state = await getMailSyncState(handle, userId);
  let ids: string[] = [];
  let nextHistoryId: string;
  let mode: 'history' | 'dated' = 'history';
  const history = state?.historyId ? await gmail.listHistory(state.historyId) : null;
  if (history && !history.expired) {
    ids = history.messageIds;
    nextHistoryId = history.historyId;
  } else {
    mode = 'dated';
    // Read before listing so nothing arriving in between falls into a gap.
    nextHistoryId = await gmail.currentHistoryId();
    const after = await fallbackStart(handle, userId, state?.lastSyncedAt);
    if (after) ids = await gmail.listSince(after);
  }

  // Messages deferred by an earlier run are retried by id: the mark moves on regardless, so a
  // deferred message never depends on the dated window still covering it.
  ids = [...new Set([...(state?.deferredMessageIds ?? []), ...ids])];
  const done = await listProcessedMessageIds(handle, ids);
  const fresh = ids.filter((id) => !done.has(id));
  const user = await getUserById(handle, userId);
  const counts = {
    linked: 0,
    unlinked: 0,
    failed: 0,
    deferred: 0,
    duplicates: ids.length - fresh.length,
  };
  const deferredIds: string[] = [];
  for (const id of fresh) {
    const msg = await gmail.getMessage(id);
    const outcome = await processMessage(handle, userId, user.email, id, msg, deps);
    if (outcome === 'duplicate') counts.duplicates++;
    else if (outcome === 'linked') counts.linked++;
    else if (outcome === 'failed') counts.failed++;
    else if (outcome === 'deferred') {
      counts.deferred++;
      deferredIds.push(id);
    } else counts.unlinked++;
  }

  // The batch is committed message by message; only now does the mark move. Messages deferred for
  // an unreadable calendar are persisted by id (not by holding the mark back), so the next run
  // retries exactly those, whichever listing mode it uses.
  await upsertMailSyncState(handle, userId, {
    historyId: nextHistoryId,
    lastSyncedAt: deps.clock.now(),
    reauthNeeded: false,
    deferredMessageIds: deferredIds,
  });
  // Repair passes for the scheduling gaps (confirmation request not sent, booking not enqueued).
  for (const repair of [deps.resendPendingConfirmations, deps.requeueUnbookedInterviews]) {
    try {
      await repair(handle, userId);
    } catch (e) {
      if (isAuthError(e)) throw e;
      await activity.logActivity(handle, {
        userId,
        actor: 'agent',
        action: 'scheduling_repair_failed',
        detail: { error: e instanceof Error ? e.name : 'error' },
      });
    }
  }
  return {
    status: 'ok',
    mode,
    messages: fresh.length,
    ...counts,
    historyId: nextHistoryId,
  };
}

/** Records the message as processed with no thread: not inbound mail, or not about an application. */
async function recordUnlinked(handle: TenantHandle, userId: string, id: string) {
  await markMessageProcessed(handle, { userId, gmailMessageId: id, outcome: 'unlinked' });
}

/**
 * One message, one transaction for everything it writes (processed marker, thread row, status
 * change, activity, flags). Linking and classification happen before the transaction so no
 * connection is held across model calls. A failure anywhere is recorded as `failed` and skipped.
 */
export async function processMessage(
  handle: TenantHandle,
  userId: string,
  userEmail: string,
  id: string,
  msg: InboxMessage | null,
  deps: InboxDeps,
): Promise<MessageOutcome> {
  try {
    if (await isMessageProcessed(handle, id)) return 'duplicate';
    if (
      !msg ||
      msg.labelIds.some((l) => NOT_INBOUND_LABELS.includes(l)) ||
      senderOf(msg.from).toLowerCase() === userEmail.toLowerCase()
    ) {
      await recordUnlinked(handle, userId, id);
      return 'unlinked';
    }
    const link = await linkMessage(handle, userId, msg, deps.llm);
    if (!link) {
      await recordUnlinked(handle, userId, id);
      return 'unlinked';
    }
    const candidates = await loadCandidates(handle, userId);
    const target = candidates.find((c) => c.application.id === link.applicationId);
    if (!target) {
      await recordUnlinked(handle, userId, id);
      return 'unlinked';
    }
    const result = await classifyMessage(deps.llm, msg, {
      companyName: target.companyName,
      jobTitle: target.job.title,
    });

    let offerToSend: OfferToSend | null = null;
    let movedToOffer = false;
    await handle.transaction(async (h) => {
      const app = await getApplication(h, link.applicationId);
      if (!app) throw new Error('linked application no longer exists');
      // First write of the transaction: the row lock is taken before any insert that references the
      // application (their foreign-key share locks would deadlock two concurrent messages).
      // The transition is computed from the stored status, not the earlier snapshot.
      const change = await applyTransition(h, app.id, result.classification, {
        appliedAt: msg.receivedAt,
        onTransition: (t) => {
          if (t.to === 'offer') movedToOffer = true;
        },
      });
      // Recorded in this transaction: the pay-data job survives a crash after the commit.
      if (movedToOffer) {
        await recordFollowOnJob(h, {
          userId,
          kind: NEGOTIATION_JOB,
          payload: { tenantId: h.tenantId, userId, applicationId: app.id },
          dedupeKey: negotiationKey(app.id),
        });
      }
      const existing = await getEmailThreadByGmailId(h, msg.threadId);
      const thread = await upsertEmailThread(h, {
        userId,
        gmailThreadId: msg.threadId,
        kind: result.classification,
        applicationId: link.applicationId,
        compensationFlag: result.compensation_flag,
        bookingLink: result.booking_link,
        subject: msg.subject,
        promptVersion: result.promptVersion,
        // The repo applies this chronologically: an older message never overwrites a newer one.
        lastMessageAt: msg.receivedAt,
      });
      if (
        !(await markMessageProcessed(h, {
          userId,
          gmailMessageId: id,
          outcome: 'linked',
          threadId: thread.id,
        }))
      ) {
        throw new AlreadyProcessed();
      }
      if (!existing) {
        await activity.logActivity(h, {
          userId,
          applicationId: app.id,
          actor: 'agent',
          action: 'thread_linked',
          detail: { method: link.method, thread_id: thread.id, gmail_message_id: id },
        });
      }

      let status = change.from ?? app.status;
      if (change.changed) {
        status = change.to;
        await activity.logActivity(h, {
          userId,
          applicationId: app.id,
          actor: 'agent',
          action: 'status_changed',
          detail: {
            from: change.from,
            to: change.to,
            ...(change.closedReason ? { closed_reason: change.closedReason } : {}),
            via: 'email',
            classification: result.classification,
            gmail_message_id: id,
          },
        });
      } else if (result.classification === 'confirmation') {
        await updateApplication(h, app.id, {}); // bumps last_activity_at
      }
      const wasClosed = (change.from ?? app.status) === 'closed';

      const flagBase = { userId, applicationId: app.id };
      const ref = { thread_id: thread.id, gmail_message_id: id };
      if (
        wasClosed &&
        (result.classification === 'interview' || result.classification === 'offer')
      ) {
        await deps.flagDigest(h, {
          ...flagBase,
          kind: 'activity_on_closed',
          detail: { ...ref, classification: result.classification },
        });
      }
      if (result.compensation_flag) {
        await deps.flagDigest(h, { ...flagBase, kind: 'compensation', detail: ref });
      }
      if (result.booking_link) {
        await deps.flagDigest(h, {
          ...flagBase,
          kind: 'booking_link',
          detail: { ...ref, link: result.booking_link },
        });
      }

      const slots: ProposedSlot[] = result.proposed_slots;
      if (slots.length > 0 && !result.booking_link && status !== 'closed') {
        const input = {
          userId,
          applicationId: app.id,
          threadId: thread.id,
          messageId: id,
          slots,
          compensationFlag: result.compensation_flag,
        };
        // Last in the transaction: if the calendar cannot be read the whole message rolls back
        // (not recorded as processed) and is retried. Only the slots are written here; the
        // confirmation email goes out after the commit, below.
        const recorded = await deps.recordOffer(h, input);
        offerToSend = recorded.send;
      }
    });
    if (offerToSend) await sendOffer(handle, userId, id, offerToSend, deps);
    return 'linked';
  } catch (e) {
    // A rejected mailbox credential is the sync's concern (revocation, mark held), never one
    // message's failure.
    if (isAuthError(e)) throw e;
    if (e instanceof AlreadyProcessed) return 'duplicate';
    if (e instanceof CalendarUnavailableError) {
      await activity.logActivity(handle, {
        userId,
        actor: 'agent',
        action: 'offer_deferred',
        detail: { gmail_message_id: id, reason: 'calendar_unavailable' },
      });
      return 'deferred';
    }
    await recordFailure(handle, userId, id, e);
    return 'failed';
  }
}

/**
 * Sends the confirmation request for slots that are already committed. A failure other than an
 * authentication error leaves the interview with `confirmation_email_sent_at` unset, which the
 * pending-confirmation repair pass of the same sync (and every later one) retries.
 */
async function sendOffer(
  handle: TenantHandle,
  userId: string,
  messageId: string,
  offer: OfferToSend,
  deps: InboxDeps,
) {
  try {
    await deps.sendOfferEmail(handle, userId, offer);
  } catch (e) {
    if (isAuthError(e)) throw e;
    await activity.logActivity(handle, {
      userId,
      actor: 'agent',
      action: 'offer_email_failed',
      detail: {
        interview_id: offer.interviewId,
        gmail_message_id: messageId,
        error: e instanceof Error ? e.name : 'error',
      },
    });
  }
}

async function recordFailure(handle: TenantHandle, userId: string, id: string, e: unknown) {
  await handle.transaction(async (h) => {
    const recorded = await markMessageProcessed(h, {
      userId,
      gmailMessageId: id,
      outcome: 'failed',
    });
    if (!recorded) return;
    await activity.logActivity(h, {
      userId,
      actor: 'agent',
      action: 'processing_failed',
      detail: {
        gmail_message_id: id,
        error: e instanceof Error ? e.name : 'error',
        message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      },
    });
  });
}
