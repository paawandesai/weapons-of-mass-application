import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activity,
  confirmSlotByTokenHash,
  getApplication,
  getInterview,
  listDemoEvents,
  listDemoMessages,
  listOutgoingMessagesForUser,
} from '@wma/db';
import { FakeLlm, type StructuredRequest } from '@wma/llm';
import { runBookInterview } from '../../src/jobs/book-interview';
import { createInboxDeps } from '../../src/inbox/wiring';
import { runMailSync } from '../../src/inbox/sync';
import { createNotificationDeps } from '../../src/notifications/deps';
import { scheduleReminders } from '../../src/notifications/reminders';
import { createSchedulingDeps } from '../../src/scheduling/ports';
import { formatSlot } from '../../src/scheduling/slots';
import { runSimulatedRecruiter, SLOTS_HEADER } from '../../src/demo/recruiter';
import { runSimulatedRecruiterTick } from '../../src/jobs/simulated-recruiter';
import { appliedTo, MONEY, setupDemoEnv, type DemoEnv } from './support';

process.env.ANTHROPIC_API_KEY ??= 'test-key-never-used';

const template = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'demo', 'proposal-classification.json'),
  'utf8',
);
const ZONE = 'America/Los_Angeles';

let env: DemoEnv;
beforeAll(async () => {
  env = await setupDemoEnv();
});
afterAll(async () => {
  await env.cleanup();
});

/** The pg-boss surface the wiring touches, recording what is enqueued. */
function fakeBoss() {
  const sent: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
      sent.push({ queue, data });
      return `job-${sent.length}`;
    }),
    createQueue: vi.fn(async () => undefined),
    findJobs: vi.fn(async () => []),
    cancel: vi.fn(async () => undefined),
  };
  return { boss: boss as unknown as PgBoss, sent };
}

describe('inbox task 7.1: applied to booked, on the demo mailbox', () => {
  it('runs proposal, sync, offer, confirm, booking and acknowledgement end to end', async () => {
    const { handle } = env;
    const { userId, tenantId } = env.summary;
    const job = await env.jobsByTitle('Senior Backend Engineer');
    const app = await appliedTo(handle, userId, job.id);

    // 1. The simulated recruiter writes the proposal (through the job entry point).
    const { boss, sent } = fakeBoss();
    const tick = await runSimulatedRecruiterTick(boss, env.db, {}, 0);
    expect(tick?.delivered.map((d) => d.kind)).toEqual(['proposal']);
    expect(sent.map((s) => s.queue)).toEqual(['mail-sync']); // queued an inbox sync for the user
    const proposal = (await listDemoMessages(handle, userId)).find(
      (m) => m.threadId === `sim-thread-${app.id}`,
    )!;
    const offered = (
      JSON.parse((proposal.headers as Record<string, string>)[SLOTS_HEADER]!) as Array<{
        start: string;
        end: string;
      }>
    ).map((s) => ({ start: new Date(s.start), end: new Date(s.end) }));
    expect(offered).toHaveLength(3);

    // 2. The real inbox sync links, classifies and offers the slots over the demo ports.
    const classification = JSON.parse(
      offered.reduce(
        (t, s, i) =>
          t
            .replace(`{{start${i + 1}}}`, s.start.toISOString())
            .replace(`{{end${i + 1}}}`, s.end.toISOString()),
        template,
      ),
    );
    const llm = new FakeLlm([
      (req: StructuredRequest) =>
        req.prompt === 'inbox-link/v1'
          ? { application_id: app.id }
          : req.user.includes(proposal.subject)
            ? classification
            : {
                classification: 'other',
                compensation_flag: false,
                booking_link: null,
                proposed_slots: [],
                confirmed_slot: null,
              },
    ]);
    const inbox = { ...createInboxDeps(boss), llm };
    const synced = await runMailSync(handle, userId, inbox);
    expect(synced).toMatchObject({ status: 'ok', linked: 1, failed: 0 });
    const confirmation = (await listDemoMessages(handle, userId)).find(
      (m) => m.labelIds.includes('SENT') && /Pick an interview time/.test(m.subject),
    )!;
    const tokens = [...confirmation.bodyText.matchAll(/\/confirm\/([A-Za-z0-9_-]+)/g)].map(
      (m) => m[1]!,
    );
    expect(tokens).toHaveLength(3);

    // 3. The user confirms one slot (the API route is tested elsewhere).
    const result = await confirmSlotByTokenHash(
      handle,
      createHash('sha256').update(tokens[1]!).digest('hex'),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('confirm failed');
    const chosen = offered[1]!;
    expect(result.startsAt.toISOString()).toBe(chosen.start.toISOString());

    // 4. The booking job replies on the thread, writes the demo calendar event, moves the card.
    const notifications = createNotificationDeps(boss);
    const booked = await runBookInterview(
      env.db,
      { tenantId, userId, interviewId: result.interviewId },
      (h, u) =>
        createSchedulingDeps(h, u, async (hh, id) => {
          await scheduleReminders(hh, id, notifications);
        }),
    );
    expect(booked).toMatchObject({ ran: true, result: { status: 'booked' } });
    expect((await getApplication(handle, app.id))?.status).toBe('interviewing');
    const interview = (await getInterview(handle, result.interviewId))!;
    expect(interview.calendarEventId).toBeTruthy();
    expect(interview.replySentAt).not.toBeNull();
    const events = await listDemoEvents(handle, userId);
    expect(events).toHaveLength(1);
    expect(events[0]!.startsAt.toISOString()).toBe(chosen.start.toISOString());
    expect(sent.filter((s) => s.queue === 'reminder').map((s) => s.data.offset)).toEqual([
      86_400, 3_600,
    ]);
    const log = await activity.listByApplication(handle, app.id, { limit: 100 });
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'simulated_message_delivered',
        'interview_reply_sent',
        'interview_booked',
      ]),
    );

    // 5. The simulated recruiter acknowledges the confirmed slot in the same thread.
    const ack = await runSimulatedRecruiter(handle, userId, { delayMs: 0 });
    expect(ack.delivered.map((d) => d.kind)).toEqual(['acknowledgement']);
    const thread = (await listDemoMessages(handle, userId)).filter(
      (m) => m.threadId === proposal.threadId,
    );
    expect(thread.map((m) => (m.labelIds.includes('SENT') ? 'user' : 'recruiter'))).toEqual([
      'recruiter',
      'user',
      'recruiter',
    ]);
    expect(thread[2]!.bodyText).toContain(formatSlot(chosen, ZONE));
    expect(thread[1]!.bodyText).toContain(formatSlot(chosen, ZONE));

    // The next sync reads the acknowledgement as part of the same application and changes nothing.
    const again = await runMailSync(handle, userId, inbox);
    expect(again).toMatchObject({ status: 'ok', failed: 0 });
    expect((await getApplication(handle, app.id))?.status).toBe('interviewing');

    // 6. Nothing the agent sent mentions money.
    const outgoing = await listOutgoingMessagesForUser(handle, userId);
    expect(outgoing.length).toBeGreaterThanOrEqual(2);
    for (const o of outgoing) expect(MONEY.test(`${o.subject}\n${o.bodyText}`)).toBe(false);
    for (const m of (await listDemoMessages(handle, userId)).filter((x) =>
      x.labelIds.includes('SENT'),
    )) {
      expect(MONEY.test(`${m.subject}\n${m.bodyText}`)).toBe(false);
    }
  });
});
