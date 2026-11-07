import type { PgBoss } from 'pg-boss';
import { createLlmClient } from '@wma/llm';
import { createBlockedLogger, createOutgoingStore, getInterview } from '@wma/db';
import { defaultGuards } from '@wma/shared';
import { BOOK_INTERVIEW_JOB, BOOK_QUEUE_OPTIONS } from '../jobs/book-interview';
import { createNotificationDeps } from '../notifications/deps';
import { scheduleReminders } from '../notifications/reminders';
import { recordOffer, resendPendingConfirmations, sendOfferEmail } from '../scheduling/offer';
import { createSchedulingDeps } from '../scheduling/ports';
import { requeueUnbookedInterviews } from '../scheduling/requeue';
import type { InboxDeps } from './deps';
import { systemInboxClock } from './deps';
import { portFactory } from '../demo/factory';
import { flagDigest } from './flags';

/** The production dependencies: the user's Gmail, the Anthropic client, the guarded sender, scheduling. */
export function createInboxDeps(boss: PgBoss): InboxDeps {
  const notifications = createNotificationDeps(boss);
  const scheduling = (handle: Parameters<typeof createSchedulingDeps>[0], userId: string) =>
    createSchedulingDeps(handle, userId, async (h, interviewId) => {
      await scheduleReminders(h, interviewId, notifications);
    });
  return {
    // Demo tenants read and write their local mailbox; real tenants get Gmail (see demo/factory).
    gmail: (handle, userId) => portFactory(handle, userId).inbox,
    llm: createLlmClient(),
    mail: (handle, userId) => {
      const ports = portFactory(handle, userId);
      return {
        sender: ports.sender,
        guards: defaultGuards,
        store: createOutgoingStore(handle, userId),
        onBlocked: createBlockedLogger(handle, userId),
        lookup: ports.sentLookup,
      };
    },
    recordOffer: async (handle, input) => {
      const recorded = await recordOffer(handle, input, scheduling(handle, input.userId));
      return {
        send:
          recorded.status === 'offered' && recorded.interviewId
            ? { interviewId: recorded.interviewId, issued: recorded.issued }
            : null,
      };
    },
    sendOfferEmail: (handle, userId, offer) =>
      sendOfferEmail(
        handle,
        offer.interviewId,
        scheduling(handle, userId),
        offer.issued as Parameters<typeof sendOfferEmail>[3],
      ),
    resendPendingConfirmations: (handle, userId) =>
      resendPendingConfirmations(handle, userId, scheduling(handle, userId)),
    requeueUnbookedInterviews: (handle, userId) =>
      requeueUnbookedInterviews(handle, userId, async (data) => {
        const interview = await getInterview(handle, data.interviewId);
        await boss.createQueue(BOOK_INTERVIEW_JOB, BOOK_QUEUE_OPTIONS);
        // Same key as the confirm route, so a booking already queued is not queued twice.
        await boss.send(BOOK_INTERVIEW_JOB, data, {
          singletonKey: `${data.interviewId}:${interview?.confirmedSlotId ?? ''}`,
          ...BOOK_QUEUE_OPTIONS,
        });
      }),
    flagDigest,
    clock: systemInboxClock,
  };
}
