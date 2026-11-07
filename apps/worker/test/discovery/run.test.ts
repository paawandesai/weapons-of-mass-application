import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getRun,
  insertApplication,
  insertRun,
  listApplications,
  listJobsByIds,
  listRunCandidates,
  listUserCompanies,
  removeUserCompany,
  schema,
  upsertCompany,
  upsertJob,
  upsertUserCompany,
} from '@wma/db';
import { FakeLlm, type StructuredRequest } from '@wma/llm';
import type { Judgment } from '@wma/shared';
import { executeDailyRun, type DailyRunDeps } from '../../src/discovery/run';
import { handOff } from '../../src/discovery/handoff';
import type { Ranked } from '../../src/discovery/rank';
import type { SourceAdapter } from '../../src/discovery/types';
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

const w = createWorld();
let env: TestEnv;
beforeAll(async () => {
  w.server.listen({ onUnhandledRequest: 'error' });
  env = await setupEnv();
});
afterEach(() => w.reset());
afterAll(async () => {
  w.server.close();
  await env.cleanup();
});

const J = (over: Partial<Judgment>): Judgment => judgment(over);

/** Judges by posting title; unknown titles are skipped. Answers company-list requests from the fixture. */
function llmByTitle(rules: Record<string, Partial<Judgment> | 'garbage'>) {
  return new FakeLlm([
    (q: StructuredRequest) => {
      if (q.prompt === 'company-list/v1') return fixtureJson('company-list.json');
      const title = q.user.match(/^Title: (.*)$/m)?.[1] ?? '';
      const rule = rules[title];
      if (rule === 'garbage') return { nope: 1 };
      return rule ? J(rule) : J({ apply: false, fit: 1, rationale: 'Not a match.' });
    },
  ]);
}

const FIXTURE_RULES = {
  'Senior Backend Engineer, Data Platform': {
    fit: 5,
    application_deadline: '2026-11-20',
    rationale: 'Best match.',
    pay_min: 110000,
    pay_max: 140000,
    currency: 'EUR',
    location_mode: 'remote',
  },
  'Staff Platform Engineer': { fit: 4, rationale: 'Platform direction.' },
  'Senior Backend Engineer': { fit: 3, rationale: 'Good match.' },
} satisfies Record<string, Partial<Judgment>>;

async function tenantWithBoards(target = 12): Promise<TestTenant> {
  const t = await env.makeTenant();
  await approveProfile(t.handle, t.userId, target);
  for (const [name, ats, slug] of [
    ['Northwind Labs', 'greenhouse', 'northwind-labs'],
    ['Quillbase', 'lever', 'quillbase'],
    ['Brightforge', 'ashby', 'brightforge'],
  ] as const) {
    const company = await upsertCompany(t.handle, {
      name,
      ats,
      boardSlug: slug,
      createdBy: 'user',
    });
    await upsertUserCompany(t.handle, { userId: t.userId, companyId: company.id, source: 'user' });
  }
  return t;
}

function deps(
  over: Partial<DailyRunDeps> = {},
): DailyRunDeps & { queue: ReturnType<typeof fakeQueue> } {
  return {
    llm: llmByTitle(FIXTURE_RULES),
    queue: fakeQueue(),
    http: fastHttp(),
    now: () => NOW,
    ...over,
  } as DailyRunDeps & { queue: ReturnType<typeof fakeQueue> };
}

const go = (
  t: TestTenant,
  d: DailyRunDeps,
  over: { date?: string; trigger?: 'scheduled' | 'manual' } = {},
) =>
  executeDailyRun(
    t.handle,
    { userId: t.userId, date: over.date ?? TODAY, trigger: over.trigger ?? 'scheduled' },
    d,
  );

const actions = async (t: TestTenant) =>
  (await activity.listByUser(t.handle, t.userId)).map((e) => e.action);

describe('daily run, end to end on fixture boards and a recorded LLM', () => {
  it('4 approved, target 12: short day with shortfall 8; every judged posting is on the record; counts add up', async () => {
    const t = await tenantWithBoards(12);
    const d = deps();
    const out = await go(t, d);
    expect(out).toMatchObject({ ran: true, status: 'short_day' });
    const run = (await getRun(t.handle, out.runId))!;
    expect(run).toMatchObject({
      status: 'short_day',
      shortDay: true,
      shortfall: 8,
      step: 'finalize',
      targetN: 12,
      error: null,
    });
    expect(run.endedAt).not.toBeNull();

    const c = run.counts as Record<string, number>;
    expect(c).toMatchObject({
      fetched: 7,
      in_run_duplicates: 1,
      deduped: 6,
      already_applied: 0,
      judged: 6,
      unjudged: 0,
      approved: 4,
      skipped: 2,
      selected: 4,
    });
    expect(c.fetched).toBe(c.deduped! + c.in_run_duplicates!);
    expect(c.fetched).toBe(c.in_run_duplicates! + c.already_applied! + c.unjudged! + c.judged!);
    expect(c.judged).toBe(c.skipped! + c.approved!);

    const status = run.sourceStatus as Record<string, { status: string }>;
    expect(Object.values(status).map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);

    // every judged posting has a row with its rationale; selected ones come first in rank order
    const rows = await listRunCandidates(t.handle, run.id);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, null, null]);
    expect(rows.slice(0, 4).map((r) => r.title)).toEqual([
      'Senior Backend Engineer, Data Platform',
      'Staff Platform Engineer',
      'Senior Backend Engineer',
      'Senior Backend Engineer',
    ]);
    expect(rows.slice(0, 4).every((r) => r.selected && r.exclusionReason === null)).toBe(true);
    expect(rows.slice(4).map((r) => r.exclusionReason)).toEqual(['not_approved', 'not_approved']);
    expect(
      rows.every((r) => r.promptVersion === 'apply-decision@v1' && r.model === 'fake-llm'),
    ).toBe(true);
    expect(rows.every((r) => (r.judgment as Judgment).rationale.length > 0)).toBe(true);

    // 4 pending applications linked to the run, each with a job, and one submit message each
    const apps = await listApplications(t.handle, t.userId);
    expect(apps).toHaveLength(4);
    expect(
      apps.every((a) => a.status === 'pending' && a.runId === run.id && a.attemptCount === 0),
    ).toBe(true);
    const jobs = await listJobsByIds(
      t.handle,
      apps.map((a) => a.jobId),
    );
    expect(jobs.map((j) => j.title).sort()).toEqual([
      'Senior Backend Engineer',
      'Senior Backend Engineer',
      'Senior Backend Engineer, Data Platform',
      'Staff Platform Engineer',
    ]);
    const dataJob = jobs.find((j) => j.title.endsWith('Data Platform'))!;
    expect(dataJob).toMatchObject({
      ats: 'greenhouse',
      atsJobId: '4001001',
      payMin: 110000,
      currency: 'EUR',
      locationMode: 'remote',
    });
    expect(dataJob.url).toBe('https://boards.greenhouse.io/northwind-labs/jobs/4001001');
    expect(d.queue.sent.map((s) => s.applicationId).sort()).toEqual(apps.map((a) => a.id).sort());
    expect(d.queue.sent.every((s) => s.tenantId === t.id && s.userId === t.userId)).toBe(true);

    // skipped postings were never stored as jobs: look at every job the tenant has, not only the
    // four that have applications
    const allJobs = await t.handle.run((tx) => tx.select().from(schema.jobs));
    expect(allJobs).toHaveLength(4);
    expect(allJobs.map((j) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());
    const skippedTitles = rows.slice(4).map((r) => r.title);
    expect(allJobs.filter((j) => skippedTitles.includes(j.title))).toEqual([]);

    const log = await actions(t);
    expect(log).toEqual(expect.arrayContaining(['run_started', 'handed_off', 'run_finished']));
    const finished = (await activity.listByUser(t.handle, t.userId)).find(
      (e) => e.action === 'run_finished',
    )!;
    expect(finished.detail).toMatchObject({ run_id: run.id, status: 'short_day' });
  });

  it('25 approved with target 12 selects exactly 12 in rank order; the other 13 are recorded as not selected', async () => {
    const t = await tenantWithBoards(12);
    const many = Array.from({ length: 25 }, (_, i) =>
      candidate({
        title: `Role ${String(i).padStart(2, '0')}`,
        ats: 'lever',
        atsJobId: `many-${t.id.slice(0, 6)}-${i}`,
        url: `https://jobs.lever.co/x/many-${i}`,
      }),
    );
    const rules: Record<string, Partial<Judgment>> = {};
    many.forEach(
      (c, i) => (rules[c.title] = { fit: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5, rationale: `r${i}` }),
    );
    const d = deps({ llm: llmByTitle(rules), adapters: [staticAdapter('lever', many)] });
    const out = await go(t, d);
    expect(out.ran && out.status).toBe('finished');
    const run = (await getRun(t.handle, out.runId))!;
    expect(run).toMatchObject({ shortDay: false, shortfall: 0 });
    expect(run.counts).toMatchObject({ approved: 25, selected: 12, over_target: 13 });
    const rows = await listRunCandidates(t.handle, run.id);
    expect(rows.filter((r) => r.selected)).toHaveLength(12);
    expect(rows.filter((r) => !r.selected && r.exclusionReason === 'over_target')).toHaveLength(13);
    expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(rows.slice(0, 12).every((r) => r.selected)).toBe(true);
    expect((rows[0]!.judgment as Judgment).fit).toBe(5);
    expect(await listApplications(t.handle, t.userId)).toHaveLength(12);
    expect(d.queue.sent).toHaveLength(12);
  });

  it('a second trigger on the same day returns the existing run and creates no duplicate applications', async () => {
    const t = await tenantWithBoards();
    const d = deps();
    const first = await go(t, d);
    const before = await listApplications(t.handle, t.userId);
    const llmCalls = (d.llm as FakeLlm).calls.length;
    const second = await go(t, d, { trigger: 'manual' });
    expect(second).toEqual({ ran: false, runId: first.runId, reason: 'run_exists' });
    expect(await listApplications(t.handle, t.userId)).toHaveLength(before.length);
    expect((d.llm as FakeLlm).calls).toHaveLength(llmCalls);
    expect(await actions(t)).toContain('run_skipped');
  });

  it('the next day nothing handed off is judged again, but a skipped posting is judged afresh (stateless)', async () => {
    const t = await tenantWithBoards();
    const d1 = deps();
    await go(t, d1);
    const d2 = deps();
    const out = await go(t, d2, { date: '2026-11-08' });
    const run = (await getRun(t.handle, out.runId))!;
    expect(run.counts).toMatchObject({
      fetched: 7,
      already_applied: 4,
      judged: 2,
      approved: 0,
      selected: 0,
    });
    const judgedTitles = (d2.llm as FakeLlm).calls
      .map((q) => q.user.match(/^Title: (.*)$/m)?.[1])
      .sort();
    expect(judgedTitles).toEqual(['Account Executive', 'Office Manager']); // skipped yesterday, judged again today
    expect(await listApplications(t.handle, t.userId)).toHaveLength(4);
    expect(run.shortfall).toBe(12);
    // no memory of day 1's judgment in the prompt
    expect((d2.llm as FakeLlm).calls.every((q) => !q.user.includes('Not a match'))).toBe(true);
  });

  it('a profile that is not approved ends the run at once, fetching nothing; approval then lets the same day run', async () => {
    const t = await env.makeTenant();
    const d = deps();
    const out = await go(t, d);
    expect(out).toMatchObject({ ran: true, status: 'skipped_no_profile' });
    expect(w.world.hits).toEqual([]);
    expect((d.llm as FakeLlm).calls).toHaveLength(0);
    const run = (await getRun(t.handle, out.runId))!;
    expect(run).toMatchObject({ status: 'skipped_no_profile', counts: {}, sourceStatus: {} });
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining(['run_started', 'profile_not_approved', 'run_finished']),
    );

    await approveProfile(t.handle, t.userId);
    const company = await upsertCompany(t.handle, {
      name: 'Brightforge',
      ats: 'ashby',
      boardSlug: 'brightforge',
      createdBy: 'user',
    });
    await upsertUserCompany(t.handle, { userId: t.userId, companyId: company.id, source: 'user' });
    const again = await go(t, deps({ adapters: [staticAdapter('ashby', [])] }));
    expect(again).toMatchObject({ ran: true, runId: out.runId, status: 'short_day' });
  });

  it('a removed company is never fetched', async () => {
    const t = await tenantWithBoards();
    const rows = await listUserCompanies(t.handle, t.userId);
    await removeUserCompany(
      t.handle,
      t.userId,
      rows.find((r) => r.company.name === 'Northwind Labs')!.company.id,
    );
    await go(t, deps());
    expect(w.world.hits).not.toContain('greenhouse:northwind-labs');
    expect(w.world.hits).toContain('lever:quillbase');
  });

  it("a removed company's HN posting is not judged, selected or handed off", async () => {
    const t = await tenantWithBoards();
    const lantern = await upsertCompany(t.handle, { name: 'Lanternworks', createdBy: 'llm' });
    await upsertUserCompany(t.handle, { userId: t.userId, companyId: lantern.id, source: 'llm' });
    await removeUserCompany(t.handle, t.userId, lantern.id);
    const llm = llmByTitle(FIXTURE_RULES);
    const out = await go(t, deps({ llm }));
    expect(out.ran).toBe(true);
    const rows = await listRunCandidates(t.handle, out.runId);
    expect(rows.map((r) => r.companyName)).not.toContain('Lanternworks');
    expect(llm.calls.some((c) => c.user.includes('Company: Lanternworks'))).toBe(false);
    const run = (await getRun(t.handle, out.runId))!;
    expect(run.counts).toMatchObject({ removed_company: 1, selected: 3 });
    const jobs = await t.handle.run((tx) => tx.select().from(schema.jobs));
    expect(jobs.some((j) => j.url.includes('lanternworks'))).toBe(false);
  });

  it('a posting another run turned into an application first is unselected, and counts agree', async () => {
    const t = await tenantWithBoards();
    // Just before the hand-off transaction opens, a run for another date commits an application
    // for the best posting: this run's hand-off must lose that posting cleanly.
    let stolen = false;
    const racing = {
      ...t,
      handle: {
        tenantId: t.handle.tenantId,
        run: t.handle.run.bind(t.handle),
        async transaction<T>(fn: Parameters<typeof t.handle.transaction<T>>[0]) {
          if (!stolen) {
            stolen = true;
            const { job } = await upsertJob(t.handle, {
              ats: 'greenhouse',
              atsJobId: '4001001',
              title: 'Senior Backend Engineer, Data Platform',
              url: 'https://boards.greenhouse.io/northwind-labs/jobs/4001001',
            });
            await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
          }
          return t.handle.transaction(fn);
        },
      },
    };
    const out = await go(racing, deps());
    expect(out.ran && out.status).toBe('short_day');
    const run = (await getRun(t.handle, out.runId))!;
    const rows = await listRunCandidates(t.handle, run.id);
    const lost = rows.find((r) => r.atsJobId === '4001001')!;
    expect(lost).toMatchObject({ selected: false, exclusionReason: 'already_applied' });
    const mine = await listApplications(t.handle, t.userId);
    const fromRun = mine.filter((a) => a.runId === run.id);
    expect(fromRun).toHaveLength(3);
    // selection flags, stored applications and counts.selected all agree
    expect(rows.filter((r) => r.selected)).toHaveLength(3);
    expect(run.counts).toMatchObject({ selected: 3, hand_off_conflicts: 1 });
    expect(run.shortfall).toBe(9);
  });

  it('a user with no company list gets one generated first, then the run uses it', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId);
    const d = deps();
    const out = await go(t, d);
    expect(out.ran && out.status).toBe('short_day');
    expect((d.llm as FakeLlm).calls[0]!.prompt).toBe('company-list/v1');
    const names = (await listUserCompanies(t.handle, t.userId))
      .filter((r) => r.company.ats)
      .map((r) => r.company.name)
      .sort();
    expect(names).toEqual(['Brightforge', 'Northwind Labs', 'Quillbase']);
    expect((await getRun(t.handle, out.runId))!.counts).toMatchObject({ approved: 4 });
  });

  it('source failures degrade the run: every source unavailable is a short day with the full shortfall', async () => {
    const t = await tenantWithBoards(7);
    w.world.hn = false;
    w.world.linkedin = 'blocked';
    for (const k of ['greenhouse:northwind-labs', 'lever:quillbase', 'ashby:brightforge'])
      w.world.failing.add(k);
    const out = await go(t, deps());
    const run = (await getRun(t.handle, out.runId))!;
    expect(run).toMatchObject({ status: 'short_day', shortDay: true, shortfall: 7 });
    expect(
      Object.values(run.sourceStatus as Record<string, { status: string }>).every(
        (s) => s.status === 'unavailable',
      ),
    ).toBe(true);
    expect(await listApplications(t.handle, t.userId)).toEqual([]);
  });

  it('one dead board makes its source partial and the run continues', async () => {
    const t = await tenantWithBoards();
    w.world.failing.add('lever:quillbase');
    const out = await go(t, deps());
    const run = (await getRun(t.handle, out.runId))!;
    expect((run.sourceStatus as Record<string, { status: string }>).lever!.status).toBe(
      'unavailable',
    );
    expect(run.counts).toMatchObject({ approved: 3 });
  });

  it('a candidate that cannot be judged is unjudged and excluded, not fatal', async () => {
    const t = await tenantWithBoards();
    const d = deps({ llm: llmByTitle({ ...FIXTURE_RULES, 'Staff Platform Engineer': 'garbage' }) });
    const out = await go(t, d);
    const run = (await getRun(t.handle, out.runId))!;
    expect(run.counts).toMatchObject({ unjudged: 1, approved: 3, judged: 5 });
    const rows = await listRunCandidates(t.handle, run.id);
    const bad = rows.find((r) => r.title === 'Staff Platform Engineer')!;
    expect(bad).toMatchObject({
      exclusionReason: 'unjudged',
      judgment: null,
      rank: null,
      selected: false,
    });
    const c = run.counts as Record<string, number>;
    expect(c.fetched).toBe(c.in_run_duplicates! + c.already_applied! + c.unjudged! + c.judged!);
  });

  it('a passed deadline is excluded from the ranked list and recorded', async () => {
    const t = await tenantWithBoards();
    const d = deps({
      llm: llmByTitle({
        ...FIXTURE_RULES,
        'Staff Platform Engineer': { fit: 5, application_deadline: '2026-11-06' },
      }),
    });
    const out = await go(t, d);
    const rows = await listRunCandidates(t.handle, out.runId);
    expect(rows.find((r) => r.title === 'Staff Platform Engineer')).toMatchObject({
      rank: null,
      selected: false,
      exclusionReason: 'deadline_passed',
    });
    expect((await getRun(t.handle, out.runId))!.counts).toMatchObject({
      approved: 4,
      deadline_passed: 1,
      selected: 3,
    });
  });

  it('an enqueue failure after commit does not fail the run; the rows stay pending and the failure is logged', async () => {
    const t = await tenantWithBoards();
    const queue = fakeQueue();
    queue.failAt = 1;
    const out = await go(t, deps({ queue }));
    expect(out.ran && out.status).toBe('short_day');
    expect(queue.sent).toHaveLength(1);
    expect(await listApplications(t.handle, t.userId, { status: ['pending'] })).toHaveLength(4);
    expect(await actions(t)).toContain('handoff_enqueue_failed');
  });

  it('a row with one failed attempt gets its retry on a later day only; the date it was created on is controlled', async () => {
    const t = await tenantWithBoards();
    const { job } = await upsertJob(t.handle, {
      title: 'Earlier',
      url: 'https://jobs.lever.co/x/earlier',
    });
    const { application } = await insertApplication(t.handle, {
      userId: t.userId,
      jobId: job.id,
      attemptCount: 1,
    });
    // pin created_at so the assertions do not depend on the database's real date
    await t.handle.run((tx) =>
      tx
        .update(schema.applications)
        .set({ createdAt: new Date('2026-11-07T08:00:00Z') })
        .where(eq(schema.applications.id, application.id)),
    );
    // a run dated the same day as the row: the retry is not yet due
    const same = deps({ adapters: [staticAdapter('lever', [])] });
    await go(t, same, { date: '2026-11-07' });
    expect(same.queue.sent).toEqual([]);
    // a run dated the next day: the single retry is enqueued
    const next = deps({ adapters: [staticAdapter('lever', [])] });
    const out = await go(t, next, { date: '2026-11-08' });
    expect(out.ran).toBe(true);
    expect(next.queue.sent.map((s) => s.applicationId)).toEqual([application.id]);
    expect(((await getRun(t.handle, out.runId))!.counts as Record<string, number>).requeued).toBe(
      1,
    );
  });

  it('attempt-zero rows of any date with no live job are enqueued again; rows with a live job are left alone', async () => {
    const t = await tenantWithBoards();
    const mk = async (slug: string) => {
      const { job } = await upsertJob(t.handle, {
        title: slug,
        url: `https://jobs.lever.co/x/${slug}`,
      });
      const { application } = await insertApplication(t.handle, {
        userId: t.userId,
        jobId: job.id,
      });
      await t.handle.run((tx) =>
        tx
          .update(schema.applications)
          .set({ createdAt: new Date('2026-11-07T08:00:00Z') })
          .where(eq(schema.applications.id, application.id)),
      );
      return application.id;
    };
    const lost = await mk('lost');
    const alive = await mk('alive');
    // a same-day replacement run: the crash left `lost` pending at attempt zero with no job
    const d = deps({ adapters: [staticAdapter('lever', [])] });
    d.queue.live.add(alive);
    const out = await go(t, d, { date: '2026-11-07' });
    expect(out.ran).toBe(true);
    expect(d.queue.sent.map((s) => s.applicationId)).toEqual([lost]);
    // and a job that failed in pg-boss (no longer live) is recovered on a later day too
    d.queue.live.clear();
    const later = deps({ adapters: [staticAdapter('lever', [])] });
    await go(t, later, { date: '2026-11-09' });
    expect(later.queue.sent.map((s) => s.applicationId).sort()).toEqual([alive, lost].sort());
  });
});

describe('hand-off atomicity and failure', () => {
  const ranked = (n: number, poisonAt = -1): Ranked[] =>
    Array.from({ length: n }, (_, i) => ({
      candidate: candidate({
        title: `H${i}`,
        ats: 'lever',
        atsJobId: `h-${Math.random().toString(36).slice(2)}`,
        url: `https://jobs.lever.co/h/${Math.random().toString(36).slice(2)}`,
        // a NUL byte is rejected by Postgres: the insert for this candidate fails mid-transaction
        description: i === poisonAt ? 'bad\u0000text' : 'fine',
      }),
      status: 'judged' as const,
      judgment: judgment({ fit: 3 }),
      promptVersion: 'apply-decision@v1',
      model: 'fake-llm',
      rank: i + 1,
    }));

  it('a failure on the 6th insert rolls back every row and enqueues nothing', async () => {
    const t = await env.makeTenant();
    const { run } = await insertRun(t.handle, { userId: t.userId, date: TODAY, targetN: 12 });
    const queue = fakeQueue();
    await expect(
      handOff(
        t.handle,
        { userId: t.userId, runId: run.id, runDate: TODAY, selected: ranked(8, 5) },
        queue,
      ),
    ).rejects.toThrow();
    expect(await listApplications(t.handle, t.userId)).toEqual([]);
    expect(queue.sent).toEqual([]);
    expect(await actions(t as TestTenant)).not.toContain('handed_off');
  });

  it('a run whose hand-off fails is `failed` with step and error, keeps its candidates, and the day can be retried', async () => {
    const t = await tenantWithBoards();
    const poisoned = Array.from({ length: 7 }, (_, i) =>
      candidate({
        title: `P${i}`,
        ats: 'lever',
        atsJobId: `p-${t.id.slice(0, 6)}-${i}`,
        url: `https://jobs.lever.co/p/${t.id.slice(0, 6)}-${i}`,
        description: i === 5 ? 'bad\u0000' : 'ok',
      }),
    );
    const rules = Object.fromEntries(poisoned.map((c) => [c.title, { fit: 3 as const }]));
    const adapters: SourceAdapter[] = [staticAdapter('lever', poisoned)];
    const out = await go(t, deps({ llm: llmByTitle(rules), adapters }));
    expect(out).toMatchObject({ ran: true, status: 'failed' });
    const run = (await getRun(t.handle, out.runId))!;
    expect(run).toMatchObject({ status: 'failed', step: 'hand_off' });
    expect(run.error).toBeTruthy();
    expect(run.endedAt).not.toBeNull();
    expect(await listApplications(t.handle, t.userId)).toEqual([]);
    expect(await listRunCandidates(t.handle, run.id)).toHaveLength(7);
    expect(await actions(t)).toContain('run_failed');

    // the failed run released the date: a retry runs, and now hands off cleanly
    const clean = poisoned.map((c) => ({ ...c, description: 'ok' }));
    const again = await go(
      t,
      deps({ llm: llmByTitle(rules), adapters: [staticAdapter('lever', clean)] }),
      { trigger: 'manual' },
    );
    expect(again.ran).toBe(true);
    expect(again.ran && again.runId).not.toBe(out.runId);
    expect(again.ran && again.status).toBe('short_day');
    expect(await listApplications(t.handle, t.userId)).toHaveLength(7);
  });

  it('an unexpected run-level error never escapes: the run is failed with the step it reached', async () => {
    const t = await tenantWithBoards();
    const adapters: SourceAdapter[] = [
      {
        id: 'lever',
        fetch: async () => ({
          status: 'ok',
          candidates: [
            candidate({
              title: '\u0000bad',
              url: 'https://jobs.lever.co/z/1',
              ats: 'lever',
              atsJobId: 'z1',
            }),
          ],
        }),
      },
    ];
    const out = await go(t, deps({ adapters }));
    expect(out).toMatchObject({ ran: true, status: 'failed' });
    expect((await getRun(t.handle, out.runId))!.step).toBe('rank');
  });
});

describe('claiming the run slot', () => {
  it('takes over a run the API queued and starts it', async () => {
    const t = await tenantWithBoards();
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: TODAY,
      trigger: 'manual',
      targetN: 12,
      step: 'queued',
    });
    const out = await go(t, deps({ adapters: [staticAdapter('lever', [])] }), {
      trigger: 'manual',
    });
    expect(out).toMatchObject({ ran: true, runId: run.id });
  });

  it('does not start beside a run that is genuinely in progress', async () => {
    const t = await tenantWithBoards();
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: TODAY,
      targetN: 12,
      step: 'judge',
    });
    const out = await go(t, deps());
    expect(out).toEqual({ ran: false, runId: run.id, reason: 'run_exists' });
  });

  it('replaces a run stranded in `running` by a dead worker', async () => {
    const t = await tenantWithBoards();
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: TODAY,
      targetN: 12,
      step: 'judge',
    });
    const later = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
    const out = await go(t, deps({ adapters: [staticAdapter('lever', [])], now: later }));
    expect(out.ran && out.runId).not.toBe(run.id);
    expect(await getRun(t.handle, run.id)).toMatchObject({ status: 'failed' });
  });

  it('two workers racing for a skipped run: exactly one takes it over, the other sees the winner', async () => {
    const t = await tenantWithBoards();
    const { run } = await insertRun(t.handle, {
      userId: t.userId,
      date: TODAY,
      targetN: 12,
      status: 'skipped_no_profile',
    });
    const a = deps({ adapters: [staticAdapter('lever', [])] });
    const b = deps({ adapters: [staticAdapter('lever', [])] });
    const [x, y] = await Promise.all([go(t, a), go(t, b)]);
    const ran = [x, y].filter((o) => o.ran);
    const lost = [x, y].filter((o) => !o.ran);
    expect(ran).toHaveLength(1);
    expect(lost).toEqual([{ ran: false, runId: run.id, reason: 'run_exists' }]);
    expect(ran[0]!.runId).toBe(run.id);
    expect(await getRun(t.handle, run.id)).toMatchObject({ status: 'short_day' });
  });

  it('a finished run is untouched by a later trigger', async () => {
    const t = await tenantWithBoards();
    await go(t, deps({ adapters: [staticAdapter('lever', [])] }));
    expect(await go(t, deps(), { trigger: 'manual' })).toMatchObject({
      ran: false,
      reason: 'run_exists',
    });
  });
});
