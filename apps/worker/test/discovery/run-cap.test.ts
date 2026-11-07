import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { activity, getRun, listApplications, listRunCandidates, listUserCompanies } from '@wma/db';
import { FakeLlm, type StructuredRequest } from '@wma/llm';
import { applyJudgeCap, executeDailyRun, type DailyRunDeps } from '../../src/discovery/run';
import { relevanceScore, type RelevanceProfile } from '../../src/discovery/rank';
import { parseJudgeCap, parseMaxPerCompany } from '../../src/jobs/daily-run';
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
  profile as fixtureProfile,
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

describe('parseMaxPerCompany (rule 16)', () => {
  it('defaults to 1, falls back on invalid values with one warning each, accepts integers >= 1', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseMaxPerCompany(undefined)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(parseMaxPerCompany('abc')).toBe(1);
    expect(parseMaxPerCompany('0')).toBe(1);
    expect(parseMaxPerCompany('1.5')).toBe(1);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(parseMaxPerCompany('3')).toBe(3);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe('per-company cap (rule 16)', () => {
  const fits: Record<string, 1 | 2 | 3 | 4 | 5> = { A1: 5, A2: 4, A3: 3, A4: 2, B1: 1 };
  const fitLlm = () =>
    new FakeLlm([
      (q: StructuredRequest) => {
        const title = q.user.match(/^Title: (.*)$/m)?.[1] ?? '';
        return judgment({ apply: true, fit: fits[title] ?? 1 });
      },
    ]);
  const roles = () => [
    ...['A1', 'A2', 'A3', 'A4'].map((title) => candidate({ title, companyName: 'Acme' })),
    candidate({ title: 'B1', companyName: 'Other Co' }),
  ];
  const go = async (target: number, maxPerCompany?: number) => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId, target);
    const out = await run(
      t,
      baseDeps({ llm: fitLlm(), maxPerCompany, adapters: [staticAdapter('greenhouse', roles())] }),
    );
    const row = await getRun(t.handle, out.runId);
    const cands = await listRunCandidates(t.handle, out.runId);
    return { counts: row!.counts as Record<string, number>, cands };
  };
  const identity = (c: Record<string, number>) =>
    expect(c.approved! - c.deadline_passed!).toBe(c.selected! + c.over_target! + c.company_cap!);

  it('cap 1, four roles at one company and one elsewhere, target 2: one of each, company_cap 3', async () => {
    const { counts, cands } = await go(2);
    expect(counts).toMatchObject({ approved: 5, selected: 2, over_target: 0, company_cap: 3 });
    identity(counts);
    expect(cands.filter((r) => r.selected).map((r) => r.title)).toEqual(['A1', 'B1']);
    expect(cands.filter((r) => r.exclusionReason === 'company_cap').map((r) => r.title)).toEqual([
      'A2',
      'A3',
      'A4',
    ]);
  });

  it('cap 2, target 3: two at the busy company plus the other, company_cap 2', async () => {
    const { counts, cands } = await go(3, 2);
    expect(counts).toMatchObject({ selected: 3, over_target: 0, company_cap: 2 });
    identity(counts);
    expect(cands.filter((r) => r.selected).map((r) => r.title)).toEqual(['A1', 'A2', 'B1']);
  });

  it('the walk stops at the target: later candidates are over_target, not company_cap', async () => {
    const { counts } = await go(1);
    expect(counts).toMatchObject({ selected: 1, over_target: 4, company_cap: 0 });
    identity(counts);
  });
});

describe('title pre-filter (rules 17, 18)', () => {
  const prof: RelevanceProfile = {
    preferences: { target_titles: ['Staff Software Engineer'] },
    survey: { target_roles: [] },
    skills: [{ name: 'Rust' }, { name: 'Kafka' }],
  };

  it('scores a matching title above an unrelated one', () => {
    const match = relevanceScore(candidate({ title: 'Staff Software Engineer, Payments' }), prof);
    const other = relevanceScore(candidate({ title: 'Account Manager' }), prof);
    expect(match).toBeGreaterThan(other);
    expect(other).toBe(0);
  });

  it('+3 when all significant words appear, +1 per word; skills count in the description', () => {
    const p: RelevanceProfile = {
      preferences: { target_titles: ['Senior Backend Engineer'] },
      survey: { target_roles: [] },
      skills: [],
    };
    expect(relevanceScore(candidate({ title: 'Backend Developer' }), p)).toBe(4);
    expect(relevanceScore(candidate({ title: 'Frontend Developer' }), p)).toBe(0);
    const withSkill = relevanceScore(
      candidate({ title: 'Account Manager', description: 'You will write Rust and run Kafka.' }),
      prof,
    );
    expect(withSkill).toBe(2);
    const late = candidate({ title: 'Account Manager', description: `${'x '.repeat(1100)} Rust` });
    expect(relevanceScore(late, prof)).toBe(0);
  });

  it('scores a target repeated across preferences and survey once, ignoring case', () => {
    const p: RelevanceProfile = {
      preferences: { target_titles: ['Backend Engineer'] },
      survey: { target_roles: ['backend engineer'] },
      skills: [],
    };
    // +3 all words, +1 for "backend" - once, not twice.
    expect(relevanceScore(candidate({ title: 'Backend Engineer' }), p)).toBe(4);
  });

  it('caps the skills bonus at 5', () => {
    const p: RelevanceProfile = {
      preferences: { target_titles: [] },
      survey: { target_roles: [] },
      skills: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7'].map((name) => ({ name })),
    };
    const c = candidate({ title: 'X', description: 'a1 b2 c3 d4 e5 f6 g7' });
    expect(relevanceScore(c, p)).toBe(5);
  });

  it('judges the relevant older posting before an unrelated newer one; seeded still first', () => {
    const rel = candidate({ title: 'Staff Software Engineer', postedAt: '2026-01-01T00:00:00Z' });
    const unrelated = candidate({ title: 'Account Manager', postedAt: '2026-11-05T00:00:00Z' });
    const seeded = candidate({ title: 'Seeded Thing' });
    const r = applyJudgeCap([unrelated, rel, seeded], 2, (c) => c === seeded, prof);
    expect(r.kept.map((c) => c.title)).toEqual(['Seeded Thing', 'Staff Software Engineer']);
    expect(r.dropped).toBe(1);
    // score 0 stays eligible when the cap allows, and is counted
    const all = applyJudgeCap([unrelated, rel], 5, () => false, prof);
    expect(all.kept.map((c) => c.title)).toEqual(['Staff Software Engineer', 'Account Manager']);
    expect(all.prefilterZero).toBe(2 - 1);
  });

  it('a run records prefilter_zero and judges by relevance', async () => {
    const t = await tenant();
    const { llm, judgedTitles } = recordingLlm();
    const out = await run(
      t,
      baseDeps({
        llm,
        judgeCap: 2,
        adapters: [
          staticAdapter('greenhouse', [
            candidate({ title: 'Account Manager', postedAt: '2026-11-05T00:00:00Z' }),
            candidate({ title: 'Senior Backend Engineer', postedAt: '2026-01-01T00:00:00Z' }),
            candidate({
              title: 'Platform Lead',
              postedAt: '2026-02-01T00:00:00Z',
              description: 'TypeScript and PostgreSQL daily.',
            }),
          ]),
        ],
      }),
    );
    expect(judgedTitles.sort()).toEqual(['Platform Lead', 'Senior Backend Engineer']);
    expect((await getRun(t.handle, out.runId))?.counts).toMatchObject({
      over_cap: 1,
      prefilter_zero: 0,
    });
    expect(fixtureProfile.skills.map((s) => s.name)).toContain('TypeScript');
  });
});
