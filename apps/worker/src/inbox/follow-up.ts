import {
  activity,
  getApplication,
  getCompany,
  getJob,
  getUserById,
  lockForAttempt,
  listEmailThreadsForApplication,
  updateApplication,
  type TenantHandle,
} from '@wma/db';
import { markRevoked } from '@wma/google';
import { sendEmailRecovering } from '@wma/shared';
import { FOLLOW_UP_DELAY_DAYS } from '../submission/constants';
import { senderAddress } from '../submission/domains';
import type { InboxDeps } from './deps';
import { isAuthError } from './gmail-reader';
import { renderFollowUp } from './templates/follow-up';

const DAY_MS = 24 * 60 * 60 * 1000;

export type FollowUpSkip =
  | 'application_missing'
  | 'locked'
  | 'already_followed_up'
  | 'not_applied'
  | 'too_early'
  | 'employer_replied'
  | 'compensation_flagged'
  | 'send_uncertain'
  | 'no_contact'
  | 'blocked'
  | 'reauth_needed';

export type FollowUpOutcome = { sent: true; to: string } | { sent: false; reason: FollowUpSkip };

const NO_REPLY =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|bounces?)([-_.+].*)?$/i;

/** An address a person could answer: not a no-reply or bounce mailbox. */
export function isReplyable(address: string): boolean {
  const local = address.split('@')[0] ?? '';
  return !NO_REPLY.test(local);
}

type Plan = { plan: { contact: string; message: ReturnType<typeof renderFollowUp> } };

/**
 * Rule 12. Sends at most one follow-up, through `sendEmail`, only when the application is still
 * Applied, no employer reply is linked, and a replyable contact is known (the sender of the
 * confirmation thread). Every skip is logged with its reason. The send is keyed by the application id: a
 * second run, or a retry after a crash, finds the stored receipt instead of sending again.
 *
 * A thread classified `confirmation` is the employer's receipt, not a reply: it does not stop the
 * follow-up and is where the contact comes from.
 */
export async function runFollowUp(
  handle: TenantHandle,
  data: { userId: string; applicationId: string },
  deps: InboxDeps,
): Promise<FollowUpOutcome> {
  const { userId, applicationId } = data;
  const skip = async (reason: FollowUpSkip, detail: Record<string, unknown> = {}) => {
    await activity.logActivity(handle, {
      userId,
      applicationId,
      actor: 'agent',
      action: 'follow_up_skipped',
      detail: { reason, ...detail },
    });
    return { sent: false, reason } as const;
  };
  try {
    // Decide under the row lock, but do not hold it across the send: the delivery receipt (written
    // on its own connection before Gmail is called) references the application row, and a repeated
    // run is stopped by the receipt's key, not by the lock.
    const planned = await handle.transaction(async (h): Promise<FollowUpOutcome | Plan> => {
      const probe = await getApplication(h, applicationId);
      if (!probe) return { sent: false, reason: 'application_missing' };
      const app = await lockForAttempt(h, applicationId);
      if (!app) return { sent: false, reason: 'locked' };
      const logSkip = async (reason: FollowUpSkip, detail: Record<string, unknown> = {}) => {
        await activity.logActivity(h, {
          userId,
          applicationId,
          actor: 'agent',
          action: 'follow_up_skipped',
          detail: { reason, ...detail },
        });
        return { sent: false, reason } as const;
      };
      if (app.followedUpAt) return logSkip('already_followed_up');
      if (app.status !== 'applied') return logSkip('not_applied', { status: app.status });
      if (
        !app.appliedAt ||
        app.appliedAt.getTime() + FOLLOW_UP_DELAY_DAYS * DAY_MS > deps.clock.now().getTime()
      ) {
        return logSkip('too_early');
      }
      const threads = await listEmailThreadsForApplication(h, applicationId);
      // Nothing is sent automatically on a thread flagged for compensation, whatever its kind.
      if (threads.some((t) => t.compensationFlag)) return logSkip('compensation_flagged');
      if (threads.some((t) => t.kind !== 'confirmation')) return logSkip('employer_replied');

      const user = await getUserById(h, userId);
      const gmail = deps.gmail(h, userId);
      let contact: string | null = null;
      for (const thread of threads) {
        for (const m of await gmail.getThread(thread.gmailThreadId)) {
          const addr = senderAddress(m.from);
          if (addr && addr !== user.email.toLowerCase() && isReplyable(addr)) {
            contact = addr;
            break;
          }
        }
        if (contact) break;
      }
      if (!contact) return logSkip('no_contact');

      const job = await getJob(h, app.jobId);
      if (!job) return logSkip('application_missing');
      const company = job.companyId ? await getCompany(h, job.companyId) : null;
      const message = renderFollowUp({
        senderName: user.displayName ?? user.email,
        companyName: company?.name ?? 'your company',
        jobTitle: job.title,
        appliedAt: app.appliedAt,
      });
      return { plan: { contact, message } };
    });
    if (!('plan' in planned)) return planned;
    const { contact, message } = planned.plan;
    const result = await sendEmailRecovering(deps.mail(handle, userId), {
      userId,
      kind: 'follow_up',
      applicationId,
      deliveryKey: `follow_up:${applicationId}`,
      to: contact,
      ...message,
    });
    if (result.status === 'blocked')
      return skip('blocked', { guard: result.guard, outgoing_id: result.outgoingId });
    if (result.status === 'uncertain')
      return skip('send_uncertain', { outgoing_id: result.outgoingId });
    await handle.transaction(async (h) => {
      await updateApplication(h, applicationId, { followedUpAt: deps.clock.now() });
      await activity.logActivity(h, {
        userId,
        applicationId,
        actor: 'agent',
        action: 'follow_up_sent',
        detail: { to: contact, outgoing_id: result.outgoingId },
      });
    });
    return { sent: true, to: contact };
  } catch (e) {
    if (!isAuthError(e)) throw e;
    await markRevoked(handle, userId);
    await activity.logActivity(handle, {
      userId,
      applicationId,
      actor: 'agent',
      action: 'mailbox_reauth_needed',
      detail: { job: 'follow-up' },
    });
    return skip('reauth_needed');
  }
}
