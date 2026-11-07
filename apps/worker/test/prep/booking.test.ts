import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getApplication,
  getInterview,
  insertProfileVersion,
  updateInterview,
  schema,
  setApprovedProfileVersion,
} from '@wma/db';
import { FakeLlm } from '@wma/llm';
import { profileDocumentSchema } from '@wma/shared';
import profile from '../../../../packages/shared/test/fixtures/profile.full.json';
import { runBookInterview } from '../../src/jobs/book-interview';
import {
  repairPendingPrepPlans,
  runPrepPlanJob,
  type PrepPlanJobData,
} from '../../src/jobs/prep-plan';
import { REMINDER_JOB } from '../../src/notifications/constants';
import {
  runReminder,
  scheduleReminders,
  type ReminderJobData,
} from '../../src/notifications/reminders';
import { offerSlots } from '../../src/scheduling';
import { makeDeps as makeNotificationDeps } from '../notifications/support';
import {
  confirmToken,
  makeHarness,
  offerInput,
  seedThread,
  setupSchedulingEnv,
  threeSlots,
  tokensIn,
  type Harness,
  type SchedulingTestEnv,
  type Seeded,
} from '../scheduling/support';
import { FakeHttp, fixtureJson } from './support';
import type { PrepPlan } from '../../src/prep';

let env: SchedulingTestEnv;
beforeAll(async () => {
  env = await setupSchedulingEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const plan = fixtureJson<PrepPlan>('prep/plan.json');

async function confirmed(s: Seeded, h: Harness) {
  await insertProfileVersion(s.t.handle, {
    userId: s.t.userId,
    document: profileDocumentSchema.parse(profile),
  });
  await setApprovedProfileVersion(s.t.handle, s.t.userId, 1);
  const out = await offerSlots(s.t.handle, offerInput(s, threeSlots()), h.deps);
  const request = h.sender.sent.filter((m) => m.kind === 'slot_confirmation').at(-1)!;
  expect((await confirmToken(s.t.handle, tokensIn(request)[0]!)).ok).toBe(true);
  return out.interviewId!;
}

const outbox = (s: Seeded) =>
  s.t.handle.run((tx) =>
    tx.select().from(schema.pendingJobs).where(eq(schema.pendingJobs.tenantId, s.t.id)),
  );

describe('booking hook (task 6.3)', () => {
  it('booking records the plan job with the booking, the plan becomes ready, and the 24h reminder links it', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await confirmed(s, h);

    const out = await runBookInterview(
      env.db,
      { tenantId: s.t.id, userId: s.t.userId, interviewId },
      () => h.deps,
    );
    expect(out.result).toMatchObject({ status: 'booked' });
    expect((await getApplication(s.t.handle, s.application.id))!.status).toBe('interviewing');

    // written inside the booking transaction; nothing was sent to the queue by the booking itself
    const rows = await outbox(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'prep-plan',
      dedupeKey: `prep-plan:${interviewId}`,
      dispatchedAt: null,
      payload: { tenantId: s.t.id, userId: s.t.userId, interviewId, onlyIfMissing: true },
    });

    // the reconciler hands the row to the queue; the test runs the job body from the payload
    await runPrepPlanJob(env.db, rows[0]!.payload as PrepPlanJobData, {
      llm: new FakeLlm([plan]),
      http: new FakeHttp(),
    });
    expect((await getInterview(s.t.handle, interviewId))!.prepPlanStatus).toBe('ready');

    // the first reminder (24h before) carries the plan link
    const interview = (await getInterview(s.t.handle, interviewId))!;
    const startsAt = interview.startsAt!;
    const deps = makeNotificationDeps(new Date(startsAt.getTime() - 72 * 3_600_000));
    await scheduleReminders(s.t.handle, interviewId, deps);
    deps.clock.set(new Date(startsAt.getTime() - 24 * 3_600_000));
    for (const j of deps.queue.takeDue(REMINDER_JOB, deps.clock.now())) {
      await runReminder(s.t.handle, j.data as unknown as ReminderJobData, deps);
    }
    const reminder = deps.sender.sent[0]!;
    expect(reminder.kind).toBe('reminder');
    expect(reminder.text).toContain(`https://app.example.test/interviews/${interviewId}/prep`);
    expect(reminder.html).toContain('Read the prep plan');
  });

  it('booking again keeps one row per interview', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await confirmed(s, h);
    for (let i = 0; i < 2; i++)
      await runBookInterview(
        env.db,
        { tenantId: s.t.id, userId: s.t.userId, interviewId },
        () => h.deps,
      );
    expect(await outbox(s)).toHaveLength(1);
  });

  it('a pending plan whose row was already dispatched is re-armed by the repair pass', async () => {
    const s = await seedThread(env);
    const h = makeHarness();
    const interviewId = await confirmed(s, h);
    await runBookInterview(
      env.db,
      { tenantId: s.t.id, userId: s.t.userId, interviewId },
      () => h.deps,
    );
    // the job was dispatched, then the worker died after marking the plan pending
    await s.t.handle.run((tx) =>
      tx
        .update(schema.pendingJobs)
        .set({ dispatchedAt: new Date() })
        .where(eq(schema.pendingJobs.tenantId, s.t.id)),
    );
    expect(await repairPendingPrepPlans(s.t.handle, s.t.userId)).toBe(0);
    await updateInterview(s.t.handle, interviewId, { prepPlanStatus: 'pending' });
    expect(await repairPendingPrepPlans(s.t.handle, s.t.userId)).toBe(1);
    const rows = await outbox(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dispatchedAt).toBeNull();
  });
});
