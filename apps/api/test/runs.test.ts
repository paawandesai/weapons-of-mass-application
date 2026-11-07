import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, getRun, getUserById, insertRun, insertRunCandidates, updateRun } from '@wma/db';
import { createRunsRoutes } from '../src/routes/runs';
import { surveyRoutes } from '../src/routes/survey';
import { requestRun, type DailyRunRequest, type RunQueue } from '../src/services/discovery';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';
import { insertProfileVersion, setApprovedProfileVersion } from '@wma/db';
import { profileDocumentSchema } from '@wma/shared';
import fixture from '../../../packages/shared/test/fixtures/profile.full.json';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

/** `outcome` scripts what the queue does: accept, decline (pg-boss returned null) or throw. */
function fakeQueue(outcome: Array<'accept' | 'decline' | 'throw'> = []) {
  const sent: DailyRunRequest[] = [];
  const script = [...outcome];
  const queue: RunQueue = {
    enqueueDailyRun: async (d) => {
      sent.push(d);
      const next = script.shift() ?? 'accept';
      if (next === 'throw') throw new Error('queue down');
      return next === 'accept';
    },
  };
  return { queue, sent };
}
const setup = (t: TestTenant, outcome: Array<'accept' | 'decline' | 'throw'> = []) => {
  const q = fakeQueue(outcome);
  return {
    ...q,
    app: appFor(t, { '/runs': createRunsRoutes({ queue: q.queue }), '/survey': surveyRoutes }),
  };
};
const today = () => new Date().toISOString().slice(0, 10);
async function approve(t: TestTenant) {
  const row = await insertProfileVersion(t.handle, {
    userId: t.userId,
    document: profileDocumentSchema.parse(fixture),
  });
  await setApprovedProfileVersion(t.handle, t.userId, row.version);
}

describe('POST /runs', () => {
  it('queues a manual run for today and answers 202 with the run', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { app, sent } = setup(t);
    const res = await app.request('/runs', { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.run).toMatchObject({
      date: today(),
      trigger: 'manual',
      status: 'running',
      step: 'queued',
      target: 12,
    });
    expect(body.candidates).toEqual([]);
    expect(sent).toEqual([{ tenantId: t.id, userId: t.userId, date: today(), trigger: 'manual' }]);
  });

  it('a second trigger on the same day returns the existing run and enqueues nothing', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { app, sent } = setup(t);
    const first = await (await app.request('/runs', { method: 'POST' })).json();
    const res = await app.request('/runs', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).run.id).toBe(first.run.id);
    expect(sent).toHaveLength(1);
  });

  it('after a scheduled run has finished, a manual trigger returns that run', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: today(),
      targetN: 12,
      status: 'running',
    });
    await updateRun(t.handle, run.id, {
      status: 'short_day',
      shortDay: true,
      shortfall: 8,
      endedAt: new Date(),
    });
    const { app, sent } = setup(t);
    const res = await app.request('/runs', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).run).toMatchObject({
      id: run.id,
      status: 'short_day',
      short_day: true,
      shortfall: 8,
    });
    expect(sent).toEqual([]);
  });

  it('an unapproved profile ends the run at once as skipped_no_profile; after approval the same day can run', async () => {
    const t = await env.makeTenant();
    const { app, sent } = setup(t);
    const res = await app.request('/runs', { method: 'POST' });
    expect(res.status).toBe(200);
    const first = (await res.json()).run;
    expect(first).toMatchObject({ status: 'skipped_no_profile', step: null });
    expect(first.ended_at).not.toBeNull();
    expect(sent).toEqual([]);
    expect((await activity.listByUser(t.handle, t.userId))[0]).toMatchObject({
      action: 'profile_not_approved',
    });
    // asking again while still unapproved gives the same run
    expect((await (await app.request('/runs', { method: 'POST' })).json()).run.id).toBe(first.id);

    await approve(t);
    const again = await app.request('/runs', { method: 'POST' });
    expect(again.status).toBe(202);
    const body = await again.json();
    expect(body.run).toMatchObject({
      id: first.id,
      status: 'running',
      step: 'queued',
      ended_at: null,
    });
    expect(sent).toHaveLength(1);
  });

  it('a failed run frees the day for a new one', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { run } = await insertRun(t.handle, { userId: t.userId, date: today(), targetN: 12 });
    await updateRun(t.handle, run.id, { status: 'failed', error: 'boom' });
    const { app, sent } = setup(t);
    const res = await app.request('/runs', { method: 'POST' });
    expect(res.status).toBe(202);
    expect((await res.json()).run.id).not.toBe(run.id);
    expect(sent).toHaveLength(1);
  });

  it('records dispatched on the run once the queue accepted it', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { app } = setup(t);
    const body = await (await app.request('/runs', { method: 'POST' })).json();
    expect((await getRun(t.handle, body.run.id))!.dispatchState).toBe('dispatched');
  });

  it('a dispatch that throws is reported, kept as failed, and retried by the next trigger', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { app, sent } = setup(t, ['throw', 'accept']);
    const first = await app.request('/runs', { method: 'POST' });
    expect(first.status).toBe(503);
    const failed = await first.json();
    expect(failed.code).toBe('dispatch_failed');
    expect(failed.run).toMatchObject({ status: 'running', step: 'queued' });
    expect((await getRun(t.handle, failed.run.id))!.dispatchState).toBe('failed');

    const second = await app.request('/runs', { method: 'POST' });
    expect(second.status).toBe(202);
    expect((await second.json()).run.id).toBe(failed.run.id); // the same row, dispatched again
    expect(sent).toHaveLength(2);
    expect((await getRun(t.handle, failed.run.id))!.dispatchState).toBe('dispatched');
    // once dispatched, a further trigger just returns the run
    const third = await app.request('/runs', { method: 'POST' });
    expect(third.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it('a send that pg-boss declines (null) is a failed dispatch, not a success', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { app, sent } = setup(t, ['decline', 'accept']);
    expect((await app.request('/runs', { method: 'POST' })).status).toBe(503);
    expect((await app.request('/runs', { method: 'POST' })).status).toBe(202);
    expect(sent).toHaveLength(2);
  });

  it('concurrent triggers on a failed dispatch re-send it exactly once', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { queue, sent } = fakeQueue(['throw', 'accept', 'accept']);
    const now = new Date();
    await requestRun(t.handle, t.userId, queue, now);
    const results = await Promise.all([
      requestRun(t.handle, t.userId, queue, now),
      requestRun(t.handle, t.userId, queue, now),
      requestRun(t.handle, t.userId, queue, now),
    ]);
    expect(results.filter((r) => r.queued)).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
  });

  it('taking over a skipped run is a compare-and-set: concurrent takeovers produce one winner and one dispatch', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: today(),
      targetN: 12,
      status: 'skipped_no_profile',
    });
    const { queue, sent } = fakeQueue();
    const now = new Date();
    const results = await Promise.all([
      requestRun(t.handle, t.userId, queue, now),
      requestRun(t.handle, t.userId, queue, now),
      requestRun(t.handle, t.userId, queue, now),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.every((r) => r.run.id === run.id)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('a skipped run that a worker already took over and finished is returned as it is, never reset', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: today(),
      targetN: 12,
      status: 'skipped_no_profile',
    });
    // the worker wins the row and finishes it
    await updateRun(t.handle, run.id, {
      status: 'finished',
      step: 'finalize',
      counts: { fetched: 3 },
    });
    const { queue, sent } = fakeQueue();
    const r = await requestRun(t.handle, t.userId, queue, new Date());
    expect(r).toMatchObject({ created: false, queued: false });
    expect(r.run).toMatchObject({ id: run.id, status: 'finished', step: 'finalize' });
    expect((await getRun(t.handle, run.id))!.counts).toEqual({ fetched: 3 });
    expect(sent).toEqual([]);
  });

  it('requestRun uses the clock it is given (UTC date)', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const { queue, sent } = fakeQueue();
    const r = await requestRun(t.handle, t.userId, queue, new Date('2030-01-02T23:59:00Z'));
    expect(r.run.date).toBe('2030-01-02');
    expect(sent[0]!.date).toBe('2030-01-02');
  });
});

describe('GET /runs/:id and /runs/latest', () => {
  async function seedRun(t: TestTenant) {
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: '2026-01-05',
      targetN: 2,
      status: 'running',
    });
    await updateRun(t.handle, run.id, {
      status: 'finished',
      counts: { fetched: 4 },
      sourceStatus: { lever: { status: 'ok', candidates: 4 } },
    });
    const j = (apply: boolean, fit: number, rationale: string) => ({
      apply,
      fit,
      rationale,
      pay_min: 90000,
      pay_max: 120000,
      currency: 'EUR',
      location_mode: 'remote',
      seniority: 'Senior',
      application_deadline: '2026-02-01',
    });
    const base = {
      companyName: 'Quillbase',
      promptVersion: 'apply-decision@v1',
      model: 'fake-llm',
    };
    await insertRunCandidates(t.handle, run.id, [
      {
        ...base,
        title: 'Skipped',
        url: 'https://x/skip',
        judgment: j(false, 1, 'No.'),
        exclusionReason: 'not_approved',
      },
      {
        ...base,
        title: 'Third',
        url: 'https://x/3',
        judgment: j(true, 3, 'Ok.'),
        rank: 3,
        exclusionReason: 'over_target',
      },
      {
        ...base,
        title: 'First',
        url: 'https://x/1',
        judgment: j(true, 5, 'Best.'),
        rank: 1,
        selected: true,
      },
      { ...base, title: 'Broken', url: 'https://x/b', exclusionReason: 'unjudged' },
      {
        ...base,
        title: 'Second',
        url: 'https://x/2',
        judgment: j(true, 4, 'Good.'),
        rank: 2,
        selected: true,
      },
    ]);
    return run;
  }

  it('returns the run record with candidates in rank order, unranked last, and no `fit` anywhere', async () => {
    const t = await env.makeTenant();
    const run = await seedRun(t);
    const { app } = setup(t);
    const res = await app.request(`/runs/${run.id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/"fit"/);
    const body = JSON.parse(text);
    expect(body.run).toMatchObject({
      id: run.id,
      status: 'finished',
      counts: { fetched: 4 },
      target: 2,
    });
    expect(body.candidates.map((c: { title: string }) => c.title).slice(0, 3)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    expect(body.candidates.slice(0, 3).map((c: { rank: number }) => c.rank)).toEqual([1, 2, 3]);
    expect(body.candidates[0]).toEqual({
      rank: 1,
      title: 'First',
      company: 'Quillbase',
      url: 'https://x/1',
      ats: null,
      apply: true,
      rationale: 'Best.',
      selected: true,
      exclusion_reason: null,
      pay_min: 90000,
      pay_max: 120000,
      currency: 'EUR',
      location_mode: 'remote',
      seniority: 'Senior',
      application_deadline: '2026-02-01',
      prompt_version: 'apply-decision@v1',
      model: 'fake-llm',
    });
    expect(body.candidates.find((c: { title: string }) => c.title === 'Third')).toMatchObject({
      selected: false,
      exclusion_reason: 'over_target',
    });
    expect(body.candidates.find((c: { title: string }) => c.title === 'Broken')).toMatchObject({
      apply: null,
      rationale: null,
      exclusion_reason: 'unjudged',
    });
  });

  it('/latest returns the newest run, or 404 when there is none', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const none = await app.request('/runs/latest');
    expect(none.status).toBe(404);
    expect((await none.json()).code).toBe('no_run');
    await insertRun(t.handle, { userId: t.userId, date: '2026-01-03', targetN: 12 });
    const newest = await seedRun(t);
    const res = await app.request('/runs/latest');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.id).toBe(newest.id);
    expect(body.candidates).toHaveLength(5);
  });

  it("another user's run, a malformed id and an unknown id are all 404", async () => {
    const mine = await env.makeTenant();
    const theirs = await env.makeTenant();
    const run = await seedRun(theirs);
    const { app } = setup(mine);
    expect((await app.request(`/runs/${run.id}`)).status).toBe(404);
    expect((await app.request('/runs/not-a-uuid')).status).toBe(404);
    // right length and character class, but not structurally UUIDs: 404, never a server error
    expect((await app.request(`/runs/${'a'.repeat(36)}`)).status).toBe(404);
    expect((await app.request(`/runs/${'-'.repeat(36)}`)).status).toBe(404);
    expect((await app.request('/runs/0000000000000-0000-0000-0000-00000000000')).status).toBe(404);
    expect((await app.request('/runs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(await getRun(mine.handle, run.id)).toBeNull();
  });
});

describe('daily target validation', () => {
  it('a target of 50 is rejected and the previous target remains', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const body = (daily_target: number) => ({
      answers: {
        target_roles: ['Backend'],
        salary_floor: 90000,
        work_life_balance: null,
        family_constraints: null,
        willing_to_relocate: null,
        career_direction: null,
        daily_target,
      },
    });
    expect((await app.request('/survey', json(body(8), 'PUT'))).status).toBe(200);
    const res = await app.request('/survey', json(body(50), 'PUT'));
    expect(res.status).toBe(400);
    expect((await getUserById(t.handle, t.userId)).dailyTarget).toBe(8);
    expect((await app.request('/survey', json(body(0), 'PUT'))).status).toBe(400);
    expect((await app.request('/survey', json(body(30), 'PUT'))).status).toBe(200);
    expect((await getUserById(t.handle, t.userId)).dailyTarget).toBe(30);
  });
});
