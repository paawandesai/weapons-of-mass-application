import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  getRun,
  insertApplication,
  listApplications,
  listRunCandidates,
  updateApplication,
  upsertCompany,
  upsertJob,
  upsertUserCompany,
} from '@wma/db';
import { FakeLlm, type StructuredRequest } from '@wma/llm';
import type { Candidate, Judgment } from '@wma/shared';
import {
  dropRejected,
  executeDailyRun,
  judgeInBatches,
  minusDays,
  needsTopUp,
  applyJudgeCap,
  type DailyRunDeps,
} from '../../src/discovery/run';
import {
  isSeniorTitle,
  relevanceScore,
  selectWithCompanyCap,
  significantWords,
  type RelevanceProfile,
} from '../../src/discovery/rank';
import {
  backfillFromRun,
  type EnqueueOptions,
  type SubmitQueue,
} from '../../src/discovery/handoff';
import { afterSubmissionAttempt, SAME_DAY_RETRY_DELAY_S } from '../../src/discovery/backfill';
import { parseCount, DAILY_RUN_EXPIRE_SECONDS } from '../../src/jobs/daily-run';
import type { SubmitApplicationJobData } from '../../src/jobs/submit-application';
import { setupEnv, type TestEnv, type TestTenant } from '../helpers';
import {
  approveProfile,
  candidate,
  createWorld,
  fastHttp,
  judgment,
  NOW,
  staticAdapter,
  TODAY,
} from './support';

const aiProfile: RelevanceProfile = {
  preferences: { target_titles: ['AI Engineer'] },
  survey: { target_roles: ['AI Engineer'] },
  skills: [],
};

describe('title pre-filter for "AI Engineer" (change 1)', () => {
  it('keeps "ai" as the significant word instead of collapsing to "engineer"', () => {
    expect(significantWords('AI Engineer')).toEqual(['ai']);
    expect(significantWords('ML Engineer')).toEqual(['ml']);
    // a title of stop words still falls back to its long words
    expect(significantWords('Staff Software Engineer')).toEqual(['staff', 'software', 'engineer']);
  });

  it('scores AI titles (and ML/LLM/agent aliases) above generic engineering titles', () => {
    const s = (title: string) => relevanceScore(candidate({ title }), aiProfile);
    expect(s('AI Engineer')).toBe(4);
    expect(s('Applied AI Engineer, Plugins')).toBe(4);
    expect(s('Machine Learning Engineer, Core Experimentation')).toBe(4);
    expect(s('Software Engineer, LLM Agents')).toBe(4);
    expect(s('Software Engineer, Online Database Infrastructure')).toBe(0);
    expect(s('Backend Engineer')).toBe(0);
  });

  it('demotes senior, staff, lead and manager titles when no target is senior', () => {
    const s = (title: string) => relevanceScore(candidate({ title }), aiProfile);
    expect(isSeniorTitle('Senior Security Engineer, Identity')).toBe(true);
    expect(isSeniorTitle('Sr. AI Engineer')).toBe(true);
    expect(isSeniorTitle('Forward Deployed Engineer')).toBe(false);
    expect(s('Senior Security Engineer, Identity')).toBeLessThan(0);
    expect(s('Staff AI Engineer')).toBeLessThan(s('AI Engineer'));
    expect(s('Engineering Manager, AI')).toBeLessThan(s('Backend Engineer'));
    // a profile that targets senior roles is not penalised
    const senior: RelevanceProfile = {
      preferences: { target_titles: ['Senior Backend Engineer'] },
      survey: { target_roles: [] },
      skills: [],
    };
    expect(relevanceScore(candidate({ title: 'Senior Backend Engineer' }), senior)).toBe(4);
  });

  it('a skill-heavy senior security posting no longer outranks a plain AI Engineer posting', () => {
    const prof: RelevanceProfile = {
      ...aiProfile,
      skills: ['Go', 'Rust', 'Terraform', 'Kubernetes', 'AWS'].map((name) => ({ name })),
    };
    const security = candidate({
      title: 'Senior Security Engineer, Identity',
      description: 'Go, Rust, Terraform, Kubernetes and AWS.',
    });
    const ai = candidate({ title: 'AI Engineer' });
    const generic = candidate({
      title: 'Software Engineer, Fraud Systems',
      description: 'Go and AWS.',
    });
    const order = applyJudgeCap([security, generic, ai], 3, () => false, prof).kept;
    expect(order.map((c) => c.title)).toEqual([
      'AI Engineer',
      'Software Engineer, Fraud Systems',
      'Senior Security Engineer, Identity',
    ]);
  });
});

describe('skip re-judging (change 2): pure parts', () => {
  it('minusDays and dropRejected', () => {
    expect(minusDays('2026-11-13', 7)).toBe('2026-11-06');
    expect(minusDays('2026-03-02', 7)).toBe('2026-02-23');
    const a = candidate({ title: 'A', url: 'https://boards.greenhouse.io/a/jobs/1' });
    const b = candidate({ title: 'B', url: 'https://boards.greenhouse.io/b/jobs/2' });
    const r = dropRejected([a, b], [{ ats: null, atsJobId: null, url: a.url }]);
    expect(r.kept).toEqual([b]);
    expect(r.dropped).toBe(1);
  });
});

describe('top-up batches (change 4): pure parts', () => {
  it('judges batches of 150 up to the 450 ceiling while more are needed', async () => {
    const pool = Array.from({ length: 1000 }, (_, i) => i);
    const seen: number[][] = [];
    const n = await judgeInBatches(pool, { batchSize: 150, ceiling: 450 }, async (b) => {
      seen.push([b[0]!, b.length]);
      return true;
    });
    expect(seen).toEqual([
      [0, 150],
      [150, 150],
      [300, 150],
    ]);
    expect(n).toBe(450);
  });

  it('stops after the first batch that meets the need, and at the end of a short pool', async () => {
    const pool = Array.from({ length: 200 }, (_, i) => i);
    let calls = 0;
    expect(
      await judgeInBatches(pool, { batchSize: 150, ceiling: 450 }, async () => {
        calls++;
        return false;
      }),
    ).toBe(150);
    expect(calls).toBe(1);
    expect(await judgeInBatches(pool, { batchSize: 150, ceiling: 450 }, async () => true)).toBe(
      200,
    );
    expect(await judgeInBatches([], { batchSize: 150, ceiling: 450 }, async () => true)).toBe(0);
  });

  it('needsTopUp: short of target or of the reserve', () => {
    expect(needsTopUp({ handedOff: 11, target: 12, reserveCompanies: 9, reserveWanted: 6 })).toBe(
      true,
    );
    expect(needsTopUp({ handedOff: 12, target: 12, reserveCompanies: 5, reserveWanted: 6 })).toBe(
      true,
    );
    expect(needsTopUp({ handedOff: 12, target: 12, reserveCompanies: 6, reserveWanted: 6 })).toBe(
      false,
    );
  });

  it('the company cap holds across batches through the shared map', () => {
    const item = (name: string) => ({
      candidate: { companyId: null, companyName: name } as never,
      name,
    });
    const taken = new Map<string, number>();
    const first = selectWithCompanyCap([item('Acme'), item('Beta')], 12, 1, taken);
    expect(first.selected.map((x) => x.name)).toEqual(['Acme', 'Beta']);
    const second = selectWithCompanyCap([item('acme'), item('Gamma')], 10, 1, taken);
    expect(second.selected.map((x) => x.name)).toEqual(['Gamma']);
    expect(second.skipped.map((x) => x.name)).toEqual(['acme']);
  });

  it('env knobs and the daily-run expiry', () => {
    expect(parseCount('X', undefined, 450)).toBe(450);
    expect(parseCount('X', '300', 450)).toBe(300);
    expect(parseCount('X', '0', 6, true)).toBe(0);
    expect(DAILY_RUN_EXPIRE_SECONDS).toBeGreaterThanOrEqual(3 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------------------------
// Database-backed
// ---------------------------------------------------------------------------------------------

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

/** A queue that records sends with their options. */
function recQueue(): SubmitQueue & { sent: Array<SubmitApplicationJobData & EnqueueOptions> } {
  const q = {
    sent: [] as Array<SubmitApplicationJobData & EnqueueOptions>,
    async enqueueSubmit(data: SubmitApplicationJobData, opts?: EnqueueOptions) {
      q.sent.push({ ...data, ...(opts ?? {}) });
    },
    async hasLiveJob() {
      return true;
    },
  };
  return q;
}

/** Approves titles that start with "Good"; records judged titles. */
function llmApproving() {
  const judged: string[] = [];
  const llm = new FakeLlm([
    (q: StructuredRequest) => {
      const title = q.user.match(/^Title: (.*)$/m)?.[1] ?? '';
      judged.push(title);
      return judgment(
        title.startsWith('Good')
          ? { apply: true, fit: 4 }
          : ({ apply: false, fit: 1, rationale: 'Not a match.' } as Partial<Judgment>),
      );
    },
  ]);
  return { llm, judged };
}

const post = (title: string, company: string, n: number): Candidate =>
  candidate({
    title,
    companyName: company,
    url: `https://boards.greenhouse.io/${company.toLowerCase().replace(/\W+/g, '')}/jobs/${n}`,
    description: 'A posting.',
  });

async function tenant(target: number): Promise<TestTenant> {
  const t = await env.makeTenant();
  await approveProfile(t.handle, t.userId, target);
  // a non-empty company list so the run asks for none
  const company = await upsertCompany(t.handle, {
    name: 'Seed Co',
    ats: 'greenhouse',
    boardSlug: `seed-co-${Math.floor(Math.random() * 1e9)}`,
    createdBy: 'user',
  });
  await upsertUserCompany(t.handle, { userId: t.userId, companyId: company.id, source: 'user' });
  return t;
}

const deps = (over: Partial<DailyRunDeps>): DailyRunDeps => ({
  llm: llmApproving().llm,
  queue: recQueue(),
  http: fastHttp(),
  now: () => NOW,
  ...over,
});

const runOn = (t: TestTenant, date: string, d: DailyRunDeps) =>
  executeDailyRun(t.handle, { userId: t.userId, date, trigger: 'manual' }, d);

describe('daily run with top-up and skip-rejected (changes 2, 4)', () => {
  it('judges another batch while short of the target, up to the ceiling', async () => {
    const t = await tenant(2);
    const { llm, judged } = llmApproving();
    const pool = [
      post('Bad 1', 'A', 1),
      post('Bad 2', 'B', 2),
      post('Good 3', 'C', 3),
      post('Bad 4', 'D', 4),
      post('Good 5', 'E', 5),
      post('Good 6', 'F', 6),
      post('Good 7', 'G', 7),
    ];
    const queue = recQueue();
    const out = await runOn(
      t,
      TODAY,
      deps({
        llm,
        queue,
        judgeCap: 2,
        dailyJudgeCeiling: 6,
        adapters: [staticAdapter('greenhouse', pool)],
      }),
    );
    expect(out.ran).toBe(true);
    const run = await getRun(t.handle, out.runId);
    // batch 1 (Bad 1, Bad 2): nothing; batch 2 (Good 3, Bad 4): 1; batch 3 (Good 5, Good 6): 2nd.
    expect(run?.counts).toMatchObject({
      judged: 6,
      approved: 3,
      selected: 2,
      batches: 3,
      over_cap: 1,
    });
    expect(run?.status).toBe('finished');
    expect(judged).toHaveLength(6);
    expect(queue.sent).toHaveLength(2);
    // Good 6 was approved but not needed: kept in reserve as an over_target row with a job.
    const rows = await listRunCandidates(t.handle, out.runId);
    expect(rows.find((r) => r.title === 'Good 6')).toMatchObject({
      selected: false,
      exclusionReason: 'over_target',
      rank: 3,
    });
  });

  it('stops after one batch when the target and reserve are met', async () => {
    const t = await tenant(1);
    const { llm, judged } = llmApproving();
    const pool = [post('Good 1', 'A', 1), post('Good 2', 'B', 2), post('Good 3', 'C', 3)];
    const out = await runOn(
      t,
      TODAY,
      deps({
        llm,
        judgeCap: 2,
        dailyJudgeCeiling: 450,
        topUpReserve: 1,
        adapters: [staticAdapter('greenhouse', pool)],
      }),
    );
    const run = await getRun(t.handle, out.runId);
    expect(run?.counts).toMatchObject({ batches: 1, judged: 2, selected: 1, over_cap: 1 });
    expect(judged).toHaveLength(2);
  });

  it('does not judge again a posting rejected by a run in the last 7 days', async () => {
    const t = await tenant(1);
    const pool = [post('Bad 1', 'A', 1), post('Good 2', 'B', 2)];
    const first = llmApproving();
    await runOn(
      t,
      minusDays(TODAY, 1),
      deps({ llm: first.llm, skipRejectedDays: 7, adapters: [staticAdapter('greenhouse', pool)] }),
    );
    expect(first.judged.sort()).toEqual(['Bad 1', 'Good 2']);
    const second = llmApproving();
    const out = await runOn(
      t,
      TODAY,
      deps({
        llm: second.llm,
        skipRejectedDays: 7,
        adapters: [staticAdapter('greenhouse', [...pool, post('Good 3', 'C', 3)])],
      }),
    );
    // Bad 1 rejected yesterday: skipped. Good 2 already applied to: dropped as already applied.
    expect(second.judged).toEqual(['Good 3']);
    expect((await getRun(t.handle, out.runId))?.counts).toMatchObject({
      recently_rejected: 1,
      already_applied: 1,
    });
  });
});

describe('backfill on failure (change 3)', () => {
  async function runWithReserve(target: number, reserveCompanies: string[]) {
    const t = await tenant(target);
    const pool = [
      post('Good 0', 'Picked', 0),
      ...reserveCompanies.map((c, i) => post(`Good ${i + 1}`, c, i + 1)),
    ];
    const queue = recQueue();
    const out = await runOn(
      t,
      TODAY,
      deps({ queue, judgeCap: 150, adapters: [staticAdapter('greenhouse', pool)] }),
    );
    const [app] = await listApplications(t.handle, t.userId);
    return { t, runId: out.runId, app: app!, queue };
  }

  it('first failure: same-day retry plus the next approved company of the run', async () => {
    const { t, runId, app } = await runWithReserve(1, ['Next', 'After']);
    const queue = recQueue();
    await updateApplication(t.handle, app.id, {
      status: 'pending',
      pendingReason: 'unmapped-field',
      attemptCount: 1,
    });
    const data = { tenantId: t.handle.tenantId, userId: t.userId, applicationId: app.id };
    const r = await afterSubmissionAttempt(env.db, queue, data, { outcome: 'pending' }, () => NOW);
    expect(r.retried).toBe(true);
    expect(r.backfill).toMatchObject({ companyName: 'Next', title: 'Good 1' });
    expect(queue.sent[0]).toMatchObject({
      applicationId: app.id,
      startAfterSeconds: SAME_DAY_RETRY_DELAY_S,
    });
    const created = (r.backfill as { created: string }).created;
    expect(queue.sent[1]).toMatchObject({ applicationId: created });
    expect(await getApplication(t.handle, created)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      runId,
    });
    const rows = await listRunCandidates(t.handle, runId);
    expect(rows.find((x) => x.title === 'Good 1')).toMatchObject({
      selected: true,
      exclusionReason: null,
    });
    expect(
      (await activity.listByUser(t.handle, t.userId)).some((e) => e.action === 'backfilled'),
    ).toBe(true);

    // The second failure closes the row and backfills nothing more.
    await updateApplication(t.handle, app.id, {
      status: 'closed',
      closedReason: 'submission-failed',
      attemptCount: 2,
    });
    const again = await afterSubmissionAttempt(
      env.db,
      queue,
      data,
      { outcome: 'closed' },
      () => NOW,
    );
    expect(again).toEqual({ retried: false, backfill: null });
    expect(queue.sent).toHaveLength(2);
  });

  it('skips companies the user already has an application with, in any run or status', async () => {
    const { t, runId, app } = await runWithReserve(1, ['Held Co', 'Fresh Co']);
    // an older application at Held Co (closed by the user), on another posting
    const company = await upsertCompany(t.handle, {
      name: 'Held Co',
      ats: 'greenhouse',
      boardSlug: `other-held-${Math.floor(Math.random() * 1e9)}`,
      createdBy: 'user',
    });
    const { job } = await upsertJob(t.handle, {
      companyId: company.id,
      title: 'Old role',
      url: 'https://boards.greenhouse.io/other-held/jobs/99',
    });
    await insertApplication(t.handle, { userId: t.userId, jobId: job.id, status: 'closed' });
    await updateApplication(t.handle, app.id, {
      status: 'pending',
      pendingReason: 'captcha-timeout',
      attemptCount: 1,
    });
    const queue = recQueue();
    const r = await backfillFromRun(t.handle, { userId: t.userId, runId, today: TODAY }, queue);
    expect(r).toMatchObject({ companyName: 'Fresh Co' });
  });

  it('does nothing while the run already has its target live, or with no reserve left', async () => {
    const { t, runId } = await runWithReserve(1, ['Next']);
    const queue = recQueue();
    expect(
      await backfillFromRun(t.handle, { userId: t.userId, runId, today: TODAY }, queue),
    ).toEqual({
      created: null,
      reason: 'target_met',
    });
    const solo = await runWithReserve(1, []);
    await updateApplication(solo.t.handle, solo.app.id, {
      status: 'closed',
      closedReason: 'submission-failed',
      attemptCount: 1,
    });
    expect(
      await backfillFromRun(
        solo.t.handle,
        { userId: solo.t.userId, runId: solo.runId, today: TODAY },
        queue,
      ),
    ).toEqual({ created: null, reason: 'no_candidate' });
    expect(queue.sent).toHaveLength(0);
  });

  it('a success or a first attempt still waiting does nothing', async () => {
    const { t, app } = await runWithReserve(1, ['Next']);
    const queue = recQueue();
    const data = { tenantId: t.handle.tenantId, userId: t.userId, applicationId: app.id };
    expect(await afterSubmissionAttempt(env.db, queue, data, { outcome: 'applied' })).toEqual({
      retried: false,
      backfill: null,
    });
    expect(await afterSubmissionAttempt(env.db, queue, data, { outcome: 'pending' })).toEqual({
      retried: false,
      backfill: null,
    });
    expect(queue.sent).toHaveLength(0);
  });
});
