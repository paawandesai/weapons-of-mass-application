import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { activity, getRun, listApplications, listRunCandidates, listUserCompanies } from '@wma/db';
import { FakeLlm, type StructuredRequest } from '@wma/llm';
import { executeDailyRun, type DailyRunDeps } from '../../src/discovery/run';
import { parseJudgeCap } from '../../src/jobs/daily-run';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';
import {
  approveProfile,
  candidate,
  createWorld,
  fakeQueue,
  fastHttp,
  fixtureJson,
  judgment,
  NOW,
  staticAdapter,
  TODAY,
} from './support';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
const w = createWorld();
let env: TestEnv;
let owner: pg.Pool;
const flagged: string[] = [];
beforeAll(async () => {
  w.server.listen({ onUnhandledRequest: 'error' });
  env = await setupEnv();
  owner = new pg.Pool({ connectionString: ownerUrl });
});
afterAll(async () => {
  w.server.close();
  if (flagged.length)
    await owner.query('update tenants set demo = false where id = any($1::uuid[])', [flagged]);
  await owner.end();
  await env.cleanup();
});

/** Approves every posting; records which titles were judged and whether the company list was asked for. */
function recordingLlm() {
  const judgedTitles: string[] = [];
  const prompts: string[] = [];
  const llm = new FakeLlm([
    (q: StructuredRequest) => {
      prompts.push(q.prompt);
      if (q.prompt === 'company-list/v1') return fixtureJson('company-list.json');
      judgedTitles.push(q.user.match(/^Title: (.*)$/m)?.[1] ?? '');
      return judgment({ apply: true, fit: 3 });
    },
  ]);
  return { llm, judgedTitles, prompts };
}

async function tenant(opts: { demo?: boolean } = {}): Promise<TestTenant> {
  const t = await env.makeTenant();
  await approveProfile(t.handle, t.userId, 12);
  if (opts.demo) {
    await owner.query('update tenants set demo = true where id = $1', [t.id]);
    flagged.push(t.id);
  }
  return t;
}

const run = (t: TestTenant, d: DailyRunDeps) =>
  executeDailyRun(t.handle, { userId: t.userId, date: TODAY, trigger: 'scheduled' }, d);

const baseDeps = (over: Partial<DailyRunDeps>): DailyRunDeps => ({
  llm: recordingLlm().llm,
  queue: fakeQueue(),
  http: fastHttp(),
  now: () => NOW,
  ...over,
});

const actions = async (t: TestTenant) => activity.listByUser(t.handle, t.userId);

describe('demo tenant runs on its seeded postings only (rules 2, 3)', () => {
  it('never asks for a company list, logs company_list_skipped/demo_tenant, fetches no board, judges seeded postings', async () => {
    const t = await tenant({ demo: true });
    const { llm, judgedTitles, prompts } = recordingLlm();
    const seeded = [
      candidate({ title: 'Seeded A', source: 'greenhouse', url: 'https://x.test/forms/a' }),
      candidate({ title: 'Seeded B', source: 'lever', url: 'https://x.test/forms/b' }),
    ];
    const queue = fakeQueue();
    const out = await run(t, baseDeps({ llm, queue, adapters: [staticAdapter('seeded', seeded)] }));
    expect(out.ran && ['finished', 'short_day']).toContain(out.ran && out.status);
    const apps = await listApplications(t.handle, t.userId);
    expect(apps.length).toBeGreaterThan(0);
    expect(queue.sent.map((s) => s.applicationId).sort()).toEqual(apps.map((a) => a.id).sort());
    expect(prompts.some((p) => p.startsWith('company-list'))).toBe(false);
    expect(await listUserCompanies(t.handle, t.userId, { includeRemoved: true })).toEqual([]);
    expect(w.world.hits).toEqual([]);
    expect(judgedTitles.sort()).toEqual(['Seeded A', 'Seeded B']);
    const skipped = (await actions(t)).filter((e) => e.action === 'company_list_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.detail).toEqual({ reason: 'demo_tenant' });
    const row = await getRun(t.handle, out.runId);
    expect(row?.counts).toMatchObject({ judged: 2, over_cap: 0 });
  });

  it('a non-demo tenant with no companies still asks for a company list', async () => {
    const t = await tenant();
    const { llm, prompts } = recordingLlm();
    await run(t, baseDeps({ llm, adapters: [staticAdapter('greenhouse', [])] }));
    expect(prompts.some((p) => p.startsWith('company-list'))).toBe(true);
    expect(
      (await actions(t)).some(
        (e) =>
          e.action === 'company_list_skipped' && JSON.stringify(e.detail).includes('demo_tenant'),
      ),
    ).toBe(false);
  });
});

describe('parseJudgeCap (rule 4)', () => {
  it('defaults to 120, falls back on invalid values with one warning, accepts integers >= 1', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseJudgeCap(undefined)).toBe(120);
    expect(warn).not.toHaveBeenCalled();
    expect(parseJudgeCap('abc')).toBe(120);
    expect(parseJudgeCap('0')).toBe(120);
    expect(parseJudgeCap('-3')).toBe(120);
    expect(parseJudgeCap('2.5')).toBe(120);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(parseJudgeCap('5')).toBe(5);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});

describe('judge cap (rules 5-7)', () => {
  const five = () => [
    candidate({ title: 'old seeded', postedAt: '2026-01-01T00:00:00Z' }),
    candidate({ title: 'dated old', postedAt: '2026-10-01T00:00:00Z' }),
    candidate({ title: 'dated new', postedAt: '2026-11-05T00:00:00Z' }),
    candidate({ title: 'undated 1' }),
    candidate({ title: 'undated 2' }),
  ];

  it('cap 2 over 5: the seeded one and the newest dated one are judged; 3 dropped, logged, no rows', async () => {
    const t = await tenant();
    const { llm, judgedTitles } = recordingLlm();
    const out = await run(
      t,
      baseDeps({
        llm,
        judgeCap: 2,
        adapters: [
          staticAdapter('hn-who-is-hiring', five().slice(1)),
          staticAdapter('seeded', five().slice(0, 1)),
        ],
      }),
    );
    expect(judgedTitles.sort()).toEqual(['dated new', 'old seeded']);
    const row = await getRun(t.handle, out.runId);
    expect(row?.counts).toMatchObject({
      deduped: 5,
      already_applied: 0,
      over_cap: 3,
      judged: 2,
      unjudged: 0,
    });
    const c = row!.counts as Record<string, number>;
    expect(c.deduped! - c.already_applied! - c.over_cap!).toBe(c.judged! + c.unjudged!);
    expect(await listRunCandidates(t.handle, out.runId)).toHaveLength(2);
    const capped = (await actions(t)).filter((e) => e.action === 'judge_capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]!.actor).toBe('agent');
    expect(capped[0]!.detail).toEqual({ run_id: out.runId, cap: 2, dropped: 3 });
  });

  it('ties keep source order: undated postings fill the cap in the order returned', async () => {
    const t = await tenant();
    const { llm, judgedTitles } = recordingLlm();
    await run(
      t,
      baseDeps({
        llm,
        judgeCap: 2,
        adapters: [
          staticAdapter('greenhouse', [
            candidate({ title: 'u1' }),
            candidate({ title: 'u2' }),
            candidate({ title: 'u3' }),
          ]),
        ],
      }),
    );
    expect(judgedTitles.sort()).toEqual(['u1', 'u2']);
  });

  it('a cap larger than the candidates changes nothing: over_cap 0, no judge_capped entry', async () => {
    const t = await tenant();
    const out = await run(
      t,
      baseDeps({ judgeCap: 50, adapters: [staticAdapter('greenhouse', five())] }),
    );
    const row = await getRun(t.handle, out.runId);
    expect(row?.counts).toMatchObject({ over_cap: 0, judged: 5 });
    expect((await actions(t)).some((e) => e.action === 'judge_capped')).toBe(false);
  });
});
