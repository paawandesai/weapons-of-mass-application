import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  getInterview,
  insertApplication,
  insertInterview,
  schema,
  updateApplication,
  updateInterview,
  upsertEmailThread,
  upsertJob,
} from '@wma/db';
import { createInterviewsRoutes } from '../src/routes/interviews';
import type { NegotiationRequest, PrepPlanRequest, PrepQueue } from '../src/services/prep';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

function fakeQueue(fail = false) {
  const prep: PrepPlanRequest[] = [];
  const negotiation: NegotiationRequest[] = [];
  const queue: PrepQueue = {
    enqueuePrepPlan: async (d) => {
      if (fail) throw new Error('queue down');
      prep.push(d);
      return true;
    },
    enqueueNegotiation: async (d) => {
      negotiation.push(d);
      return true;
    },
  };
  return { queue, prep, negotiation };
}

const setup = (t: TestTenant, fail = false) => {
  const q = fakeQueue(fail);
  const clock = { at: new Date('2026-11-07T10:00:00Z') };
  return {
    ...q,
    clock,
    app: appFor(t, {
      '/interviews': createInterviewsRoutes({ queue: q.queue, now: () => clock.at }),
    }),
  };
};

let n = 0;
async function seedInterview(t: TestTenant, status: 'applied' | 'closed' | 'offer' = 'applied') {
  n++;
  const { job } = await upsertJob(t.handle, {
    title: `Engineer ${n}`,
    url: `https://jobs.example.test/api-interviews/${t.id}/${n}`,
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
  await updateApplication(t.handle, application.id, { status });
  const thread = await upsertEmailThread(t.handle, {
    userId: t.userId,
    gmailThreadId: `thr-${t.id}-${n}`,
    kind: 'interview',
    applicationId: application.id,
  });
  const { interview } = await insertInterview(t.handle, {
    userId: t.userId,
    applicationId: application.id,
    threadId: thread.id,
  });
  await updateInterview(t.handle, interview.id, {
    confirmedAt: new Date(),
    startsAt: new Date('2026-11-20T17:00:00Z'),
    endsAt: new Date('2026-11-20T18:00:00Z'),
  });
  return { application, interview };
}

async function seedApplication(t: TestTenant, status: 'applied' | 'closed' = 'applied') {
  n++;
  const { job } = await upsertJob(t.handle, {
    title: `Engineer ${n}`,
    url: `https://jobs.example.test/api-interviews/${t.id}/${n}`,
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
  await updateApplication(t.handle, application.id, { status });
  return application;
}

describe('record an interview booked outside the app', () => {
  const starts_at = '2026-11-20T17:00:00.000Z';

  it('stores it confirmed, moves the card to Interviewing, queues the prep plan and logs the user', async () => {
    const t = await env.makeTenant();
    const { app, prep } = setup(t);
    const application = await seedApplication(t);
    const res = await app.request(
      `/interviews/for-application/${application.id}/record`,
      json({ starts_at, ends_at: '2026-11-20T17:45:00.000Z' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { interview: Record<string, unknown>; enqueued: boolean };
    expect(body.interview).toMatchObject({
      application_id: application.id,
      starts_at,
      ends_at: '2026-11-20T17:45:00.000Z',
      confirmed: true,
      booked_via: 'manual',
    });
    expect(body.enqueued).toBe(true);
    expect(prep.map((p) => p.interviewId)).toEqual([body.interview.id]);
    const row = (await getInterview(t.handle, body.interview.id as string))!;
    expect(row.threadId).toBeNull();
    expect(row.confirmedSlotId).toBeNull();
    expect(row.bookedGeneration).toBe(row.confirmedGeneration);
    expect((await getApplication(t.handle, application.id))?.status).toBe('interviewing');
    const log = await activity.listByApplication(t.handle, application.id);
    const recorded = log.find((e) => e.action === 'interview_recorded');
    expect(recorded?.actor).toBe('user');
    expect(recorded?.detail).toMatchObject({ booked_via: 'manual', starts_at });
    // The prep plan was handed to the queue directly, so the outbox row is already dispatched.
    const pending = await t.handle.run((tx) =>
      tx.select().from(schema.pendingJobs).where(eq(schema.pendingJobs.tenantId, t.id)),
    );
    expect(pending.find((p) => p.kind === 'prep-plan')?.dispatchedAt).not.toBeNull();
    expect(pending.find((p) => p.kind === 'schedule-reminders')?.dispatchedAt).toBeNull();
  });

  it('an end defaults to an hour after the start', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const application = await seedApplication(t);
    const res = await app.request(
      `/interviews/for-application/${application.id}/record`,
      json({ starts_at }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { interview: { ends_at: string } };
    expect(body.interview.ends_at).toBe('2026-11-20T18:00:00.000Z');
  });

  it('refuses a past time, an end before the start and unreadable input', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const application = await seedApplication(t);
    const url = `/interviews/for-application/${application.id}/record`;
    const past = await app.request(url, json({ starts_at: '2026-11-07T09:00:00.000Z' }));
    expect(past.status).toBe(400);
    expect(((await past.json()) as { code: string }).code).toBe('invalid_time');
    const inverted = await app.request(
      url,
      json({ starts_at, ends_at: '2026-11-20T16:00:00.000Z' }),
    );
    expect(inverted.status).toBe(400);
    const garbage = await app.request(url, json({ starts_at: 'next tuesday' }));
    expect(garbage.status).toBe(400);
    const missing = await app.request(url, json({}));
    expect(missing.status).toBe(400);
    expect(await getApplication(t.handle, application.id)).toMatchObject({ status: 'applied' });
  });

  it("a closed application takes no interview; another user's application is not found", async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const closed = await seedApplication(t, 'closed');
    const res = await app.request(
      `/interviews/for-application/${closed.id}/record`,
      json({ starts_at }),
    );
    expect(res.status).toBe(409);
    const other = await env.makeTenant();
    const theirs = await seedApplication(other);
    const stranger = await app.request(
      `/interviews/for-application/${theirs.id}/record`,
      json({ starts_at }),
    );
    expect(stranger.status).toBe(404);
  });
});

describe('feedback', () => {
  it('submits feedback, stamps it, writes a user-actor activity entry and shows it on the interview', async () => {
    const t = await env.makeTenant();
    const { app, clock } = setup(t);
    const { application, interview } = await seedInterview(t);
    const res = await app.request(
      `/interviews/${interview.id}/feedback`,
      json({ notes: '  Went well  ', relayed: '', rating: 4 }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).feedback).toEqual({
      notes: 'Went well',
      relayed: '',
      rating: 4,
      submitted_at: clock.at.toISOString(),
      updated_at: clock.at.toISOString(),
    });
    const log = await activity.listByApplication(t.handle, application.id);
    const entry = log.find((e) => e.action === 'feedback_submitted')!;
    expect(entry.actor).toBe('user');
    expect(JSON.stringify(entry.detail)).not.toContain('Went well');
    const view = await (await app.request(`/interviews/${interview.id}`)).json();
    expect(view.interview.feedback).toMatchObject({ notes: 'Went well', rating: 4 });
    // a second create is refused rather than overwriting
    const again = await app.request(
      `/interviews/${interview.id}/feedback`,
      json({ notes: 'x', relayed: '', rating: null }),
    );
    expect(again.status).toBe(409);
  });

  it('an edit keeps submitted_at and moves updated_at', async () => {
    const t = await env.makeTenant();
    const { app, clock } = setup(t);
    const { application, interview } = await seedInterview(t);
    const first = clock.at.toISOString();
    await app.request(
      `/interviews/${interview.id}/feedback`,
      json({ notes: 'first', relayed: '', rating: 2 }),
    );
    clock.at = new Date('2026-11-08T09:30:00Z');
    const res = await app.request(
      `/interviews/${interview.id}/feedback`,
      json({ notes: 'second', relayed: 'They liked the design round', rating: 5 }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).feedback).toEqual({
      notes: 'second',
      relayed: 'They liked the design round',
      rating: 5,
      submitted_at: first,
      updated_at: clock.at.toISOString(),
    });
    const stored = (await getInterview(t.handle, interview.id))!.feedback as Record<
      string,
      unknown
    >;
    expect(stored.submitted_at).toBe(first);
    const actions = (await activity.listByApplication(t.handle, application.id)).map(
      (e) => e.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['feedback_submitted', 'feedback_edited']));
  });

  it('rejects an empty submission, and an edit with nothing to edit', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const { interview } = await seedInterview(t);
    for (const body of [{}, { notes: '   ', relayed: '' }, { notes: '', relayed: '', rating: 3 }]) {
      const res = await app.request(`/interviews/${interview.id}/feedback`, json(body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('empty_feedback');
    }
    expect((await getInterview(t.handle, interview.id))!.feedback).toBeNull();
    const bad = await app.request(
      `/interviews/${interview.id}/feedback`,
      json({ notes: 'ok', rating: 9 }),
    );
    expect(bad.status).toBe(400);
    const edit = await app.request(
      `/interviews/${interview.id}/feedback`,
      json({ notes: 'ok' }, 'PUT'),
    );
    expect(edit.status).toBe(404);
  });

  it("another tenant's interview is not found", async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    const { interview } = await seedInterview(a);
    const other = setup(b).app;
    expect((await other.request(`/interviews/${interview.id}`)).status).toBe(404);
    expect(
      (await other.request(`/interviews/${interview.id}/feedback`, json({ notes: 'x' }))).status,
    ).toBe(404);
    expect((await other.request(`/interviews/${interview.id}/prep-plan`, json({}))).status).toBe(
      404,
    );
    expect((await other.request('/interviews/not-a-uuid')).status).toBe(404);
  });
});

describe('prep plan on demand', () => {
  it('enqueues once and is a no-op while pending', async () => {
    const t = await env.makeTenant();
    const { app, prep } = setup(t);
    const { interview } = await seedInterview(t);
    const first = await app.request(`/interviews/${interview.id}/prep-plan`, json({}));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'pending', enqueued: true });
    const second = await app.request(`/interviews/${interview.id}/prep-plan`, json({}));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'pending', enqueued: false });
    expect(prep).toEqual([{ tenantId: t.id, userId: t.userId, interviewId: interview.id }]);
    expect((await getInterview(t.handle, interview.id))!.prepPlanStatus).toBe('pending');
  });

  it('can be requested again after a failure', async () => {
    const t = await env.makeTenant();
    const { app, prep } = setup(t);
    const { interview } = await seedInterview(t);
    await updateInterview(t.handle, interview.id, { prepPlanStatus: 'failed' });
    expect((await app.request(`/interviews/${interview.id}/prep-plan`, json({}))).status).toBe(202);
    expect(prep).toHaveLength(1);
  });

  it('a queue that is down still records the work for the reconciler', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t, true);
    const { interview } = await seedInterview(t);
    const res = await app.request(`/interviews/${interview.id}/prep-plan`, json({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending', enqueued: false });
    expect((await getInterview(t.handle, interview.id))!.prepPlanStatus).toBe('pending');
    const rows = await t.handle.run((tx) =>
      tx.select().from(schema.pendingJobs).where(eq(schema.pendingJobs.tenantId, t.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'prep-plan',
      dedupeKey: `prep-plan:${interview.id}`,
      dispatchedAt: null,
      payload: { tenantId: t.id, userId: t.userId, interviewId: interview.id },
    });
  });

  it('a closed application is not actionable: nothing is queued and the skip is logged', async () => {
    const t = await env.makeTenant();
    const { app, prep } = setup(t);
    const { interview, application } = await seedInterview(t, 'closed');
    const res = await app.request(`/interviews/${interview.id}/prep-plan`, json({}));
    expect(res.status).toBe(409);
    expect(prep).toEqual([]);
    const actions = (await activity.listByApplication(t.handle, application.id)).map(
      (e) => e.action,
    );
    expect(actions).toContain('skipped_not_actionable');
  });
});

describe('card extras', () => {
  it('lists the interviews with a parsed plan and the offer panel data, tenant-scoped', async () => {
    const t = await env.makeTenant();
    const other = await env.makeTenant();
    const { app } = setup(t);
    const { interview, application } = await seedInterview(t, 'offer');
    const plan = {
      likely_questions: [{ question: 'Q', answer_outline: 'A' }],
      topics: ['T'],
      company_research: 'R',
      interviewer_background: null,
    };
    await updateInterview(t.handle, interview.id, {
      prepPlanStatus: 'ready',
      prepPlan: JSON.stringify(plan),
    });
    const { setNegotiation } = await import('@wma/db');
    await setNegotiation(t.handle, application.id, {
      posted_min: 200000,
      posted_max: 240000,
      currency: 'USD',
      floor: 180000,
      comparables: [],
      fetched_at: '2026-11-07T10:00:00.000Z',
      error: 'no_data',
    });
    const body = await (await app.request(`/interviews/for-application/${application.id}`)).json();
    expect(body.interviews).toHaveLength(1);
    expect(body.interviews[0]).toMatchObject({
      id: interview.id,
      confirmed: true,
      prep_plan_status: 'ready',
      prep_plan: plan,
      feedback: null,
    });
    expect(body.negotiation).toMatchObject({ posted_min: 200000, floor: 180000, error: 'no_data' });
    expect(body.llm_usage).toMatchObject({ calls: 0, cost_usd: 0 });
    expect((await getApplication(t.handle, application.id))!.status).toBe('offer');

    const res = await setup(other).app.request(`/interviews/for-application/${application.id}`);
    expect(res.status).toBe(404);
  });

  it('requests pay data only for a card in Offer', async () => {
    const t = await env.makeTenant();
    const { app, negotiation } = setup(t);
    const applied = await seedInterview(t, 'applied');
    const offer = await seedInterview(t, 'offer');
    const no = await app.request(
      `/interviews/for-application/${applied.application.id}/negotiation`,
      json({}),
    );
    expect(no.status).toBe(409);
    const yes = await app.request(
      `/interviews/for-application/${offer.application.id}/negotiation`,
      json({}),
    );
    expect(yes.status).toBe(202);
    expect(negotiation).toEqual([
      { tenantId: t.id, userId: t.userId, applicationId: offer.application.id },
    ]);
  });
});
