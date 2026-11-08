import type { PgBoss } from 'pg-boss';
import type { Db } from '@wma/db';
import {
  DRAFT_OUTREACH_JOB,
  DRAFT_OUTREACH_QUEUE_OPTIONS,
  SEND_OUTREACH_JOB,
  SEND_OUTREACH_QUEUE_OPTIONS,
  type DraftOutreachData,
  type SendOutreachData,
} from '@wma/shared';
import { guardedJob } from '../guarded';
import type { InboxDeps } from '../inbox/deps';
import { generateOutreachDraft } from '../outreach/draft';
import { sendApprovedOutreach } from '../outreach/send';

/** Registers the outreach consumers: drafting (LLM, sends nothing) and sending (approved drafts only). */
export async function registerOutreach(
  boss: PgBoss,
  db: Db,
  options: { deps?: InboxDeps } = {},
): Promise<void> {
  let deps = options.deps;
  const getDeps = async () => (deps ??= (await import('../inbox/wiring')).createInboxDeps(boss));
  await boss.createQueue(DRAFT_OUTREACH_JOB, DRAFT_OUTREACH_QUEUE_OPTIONS);
  await boss.createQueue(SEND_OUTREACH_JOB, SEND_OUTREACH_QUEUE_OPTIONS);

  await boss.work<DraftOutreachData>(DRAFT_OUTREACH_JOB, async (jobs) => {
    for (const job of jobs) {
      const { tenantId, userId, applicationId, contact } = job.data;
      const inbox = await getDeps();
      const handle = db.forTenant(tenantId);
      await guardedJob(DRAFT_OUTREACH_JOB, ({ approvedVersion }) =>
        generateOutreachDraft(
          handle,
          {
            userId,
            applicationId,
            approvedVersion,
            contact: {
              name: contact.name,
              title: contact.title,
              profileUrl: contact.profile_url,
              email: contact.email,
            },
          },
          { llm: inbox.llm },
        ),
      )({ handle, userId });
    }
  });

  await boss.work<SendOutreachData>(SEND_OUTREACH_JOB, async (jobs) => {
    for (const job of jobs) {
      const { tenantId, userId, draftId } = job.data;
      const inbox = await getDeps();
      const handle = db.forTenant(tenantId);
      await guardedJob(SEND_OUTREACH_JOB, () =>
        sendApprovedOutreach(handle, { userId, draftId }, { mail: inbox.mail, clock: inbox.clock }),
      )({ handle, userId });
    }
  });
}
