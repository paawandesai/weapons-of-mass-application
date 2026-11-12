import {
  activity,
  claimOutreachForSend,
  countOutreachSentSince,
  getOutreachDraft,
  markOutreachFailed,
  markOutreachSent,
  type TenantHandle,
} from '@wma/db';
import { markRevoked } from '@wma/google';
import { OUTREACH_DAILY_CAP, sendEmailRecovering, type MailDeps } from '@wma/shared';
import { isAuthError } from '../inbox/gmail-reader';
import { isReplyable } from '../inbox/follow-up';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type SendOutreachOutcome =
  | { sent: true; outgoingId: string }
  | {
      sent: false;
      reason:
        | 'not_approved'
        | 'daily_cap'
        | 'not_replyable'
        | 'blocked'
        | 'send_uncertain'
        | 'reauth_needed';
    };

export interface SendOutreachDeps {
  mail(handle: TenantHandle, userId: string): MailDeps;
  clock: { now(): Date };
  /** Per-day cap; defaults to OUTREACH_DAILY_CAP. */
  dailyCap?: number;
}

const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The only path that sends outreach, and it sends only what the user approved. `claimOutreachForSend`
 * returns the draft only while its stored approval still matches its recipient, subject and body;
 * an edit, a rejection or a draft that was never approved returns nothing and nothing is sent. The
 * send is keyed by the draft id, so a retry (a crashed job, a repeated queue message) never sends twice.
 */
export async function sendApprovedOutreach(
  handle: TenantHandle,
  data: { userId: string; draftId: string },
  deps: SendOutreachDeps,
): Promise<SendOutreachOutcome> {
  const { userId, draftId } = data;
  const draft = await claimOutreachForSend(handle, userId, draftId);
  const log = (action: string, detail: Record<string, unknown>, applicationId?: string | null) =>
    activity.logActivity(handle, {
      userId,
      applicationId: applicationId ?? null,
      actor: 'agent',
      action,
      detail: { draft_id: draftId, ...detail },
    });
  if (!draft) {
    await log('outreach_send_refused', { reason: 'not_approved' });
    return { sent: false, reason: 'not_approved' };
  }
  const fail = async (
    reason: 'daily_cap' | 'not_replyable' | 'blocked',
    detail: Record<string, unknown> = {},
  ) => {
    await markOutreachFailed(handle, userId, draftId, reason);
    await log('outreach_send_failed', { reason, ...detail }, draft.applicationId);
    return { sent: false, reason } as const;
  };

  const cap = deps.dailyCap ?? OUTREACH_DAILY_CAP;
  // This draft is already counted (it is `sending`), so over the cap means more than `cap` in all.
  const today = await countOutreachSentSince(handle, userId, startOfUtcDay(deps.clock.now()));
  if (today > cap) return fail('daily_cap', { cap });
  if (!isReplyable(draft.toAddress)) return fail('not_replyable');

  try {
    const result = await sendEmailRecovering(deps.mail(handle, userId), {
      userId,
      kind: 'outreach',
      applicationId: draft.applicationId,
      deliveryKey: `outreach:${draft.id}`,
      to: draft.toAddress,
      subject: draft.subject,
      text: draft.bodyText,
      html: draft.bodyText
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
        .join(''),
    });
    if (result.status === 'blocked')
      return fail('blocked', { guard: result.guard, outgoing_id: result.outgoingId });
    if (result.status === 'uncertain') {
      // Left `sending`: the next attempt reconciles through the delivery key.
      await log('outreach_send_uncertain', { outgoing_id: result.outgoingId }, draft.applicationId);
      return { sent: false, reason: 'send_uncertain' };
    }
    await markOutreachSent(handle, userId, draftId, result.outgoingId, deps.clock.now());
    await log(
      'outreach_sent',
      { to: draft.toAddress, outgoing_id: result.outgoingId },
      draft.applicationId,
    );
    return { sent: true, outgoingId: result.outgoingId };
  } catch (e) {
    if (!isAuthError(e)) throw e;
    await markRevoked(handle, userId);
    await log('mailbox_reauth_needed', { job: 'send-outreach' }, draft.applicationId);
    return { sent: false, reason: 'reauth_needed' };
  }
}

/** Used by the job to tell a missing draft from a refused one. */
export const draftExists = async (handle: TenantHandle, userId: string, id: string) =>
  (await getOutreachDraft(handle, userId, id)) !== null;
