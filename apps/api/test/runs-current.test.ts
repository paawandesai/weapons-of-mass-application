import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertRun, insertRunCandidates, updateRun } from '@wma/db';
import { createRunsRoutes } from '../src/routes/runs';
import { appFor, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const app = (t: TestTenant) => appFor(t, { '/runs': createRunsRoutes() });
const judgment = (apply: boolean, rationale: string) => ({
  apply,
  rationale,
  fit: 4,
  pay_min: null,
  pay_max: null,
  currency: null,
  location_mode: 'remote',
  seniority: 'Staff',
  application_deadline: null,
});

async function seedRun(t: TestTenant, count: number, status: 'running' | 'finished' = 'finished') {
  const { run } = await insertRun(t.handle, {
    userId: t.userId,
    date: new Date().toISOString().slice(0, 10),
    targetN: 3,
  });
  await updateRun(t.handle, run.id, {
    status,
    counts: { judged: count, approved: 2, selected: 1 },
  });
  await insertRunCandidates(
    t.handle,
    run.id,
    // inserted out of rank order on purpose; the unranked one goes last
    [
      { title: 'Rank 3', rank: 3, apply: true },
      { title: 'Rank 1', rank: 1, apply: true, selected: true },
      { title: 'Unranked', rank: null, apply: false },
      { title: 'Rank 2', rank: 2, apply: false },
    ]
      .slice(0, count)
      .map((c) => ({
        title: c.title,
        companyName: `Co ${c.title}`,
        url: `https://jobs.example.test/${c.title.replace(' ', '-')}`,
        rank: c.rank,
        selected: c.selected ?? false,
        exclusionReason: c.apply ? (c.selected ? null : 'over_target') : 'not_approved',
        judgment: judgment(c.apply, `why ${c.title}`),
      })),
  );
  return run;
}

describe('GET /runs/current', () => {
  it('returns candidates in rank order with the verdict and rationale, and never fit', async () => {
    const t = await env.makeTenant();
    const run = await seedRun(t, 4);
    const res = await app(t).request('/runs/current');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toMatchObject({ id: run.id, status: 'finished' });
    expect(body.candidates.map((c: { title: string }) => c.title)).toEqual([
      'Rank 1',
      'Rank 2',
      'Rank 3',
      'Unranked',
    ]);
    expect(body.candidates[0]).toMatchObject({
      apply: true,
      selected: true,
      rationale: 'why Rank 1',
      company: 'Co Rank 1',
    });
    expect(body.candidates[1]).toMatchObject({ apply: false, exclusion_reason: 'not_approved' });
    expect(JSON.stringify(body)).not.toMatch(/"fit"/);
    expect(body.has_more).toBe(false);
  });

  it('shows the in-progress run, and pages with a cursor', async () => {
    const t = await env.makeTenant();
    const run = await seedRun(t, 4, 'running');
    const a = app(t);
    const first = await (await a.request('/runs/current?limit=2')).json();
    expect(first.run).toMatchObject({ id: run.id, status: 'running' });
    expect(first.candidates.map((c: { title: string }) => c.title)).toEqual(['Rank 1', 'Rank 2']);
    expect(first.has_more).toBe(true);

    const second = await (
      await a.request(`/runs/current?limit=2&cursor=${first.next_cursor}`)
    ).json();
    expect(second.candidates.map((c: { title: string }) => c.title)).toEqual([
      'Rank 3',
      'Unranked',
    ]);
    expect(second.has_more).toBe(false);

    const none = await (await a.request(`/runs/current?cursor=${second.next_cursor}`)).json();
    expect(none.candidates).toEqual([]);
    expect(none.next_cursor).toBe(second.next_cursor);
  });

  it('ignores a cursor from another run and starts over', async () => {
    const t = await env.makeTenant();
    await seedRun(t, 4);
    const bad = Buffer.from(JSON.stringify({ run: 'other', rank: 3, id: 'x' })).toString(
      'base64url',
    );
    const body = await (await app(t).request(`/runs/current?cursor=${bad}`)).json();
    expect(body.candidates).toHaveLength(4);
    const garbage = await (await app(t).request('/runs/current?cursor=%%%')).json();
    expect(garbage.candidates).toHaveLength(4);
  });

  it("does not show another tenant's run", async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    await seedRun(a, 4, 'running');
    const body = await (await app(b).request('/runs/current')).json();
    expect(body.run).toBeNull();
    expect(body.candidates).toEqual([]);
  });

  it('a user without any run gets the empty state and no schedule before approval', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/runs/current');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run: null,
      candidates: [],
      next_cursor: null,
      has_more: false,
      next_run_at: null,
    });
  });
});
