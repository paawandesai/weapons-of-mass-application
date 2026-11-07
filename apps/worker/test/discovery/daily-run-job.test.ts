import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import {
  getRun,
  getRunForDate,
  insertApplication,
  insertRun,
  insertRunCandidates,
  listRunCandidates,
  upsertCompany,
  upsertJob,
  upsertUserCompany,
  getApplication,
} from '@wma/db';
import { FakeLlm } from '@wma/llm';
import {
  cleanupOldRuns,
  dbRoster,
  DAILY_RUN_CLEANUP_JOB,
  DAILY_RUN_JOB,
  DAILY_RUN_TICK_JOB,
  dailyRunKey,
  enqueueDailyRun,
  enqueueScheduledRuns,
  registerDailyRun,
  type Roster,
} from '../../src/jobs/daily-run';
import { setupEnv, type TestEnv } from '../helpers';
import {
  approveProfile,
  candidate,
  fakeQueue,
  judgment,
  NOW,
  staticAdapter,
  TODAY,
} from './support';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';

let env: TestEnv;
let boss: PgBoss;
beforeAll(async () => {
  env = await setupEnv();
  boss = new PgBoss(ownerUrl);
  boss.on('error', () => {});
  await boss.start();
});
afterAll(async () => {
  await boss.unschedule(DAILY_RUN_TICK_JOB).catch(() => {});
  await boss.unschedule(DAILY_RUN_CLEANUP_JOB).catch(() => {});
  await boss.stop({ graceful: false, timeout: 2000 });
  await env.cleanup();
});

async function freshBoss(): Promise<PgBoss> {
  const b = new PgBoss(ownerUrl);
  b.on('error', () => {});
  await b.start();
  return b;
}

const roster = (
  users: Array<{ tenantId: string; userId: string; runHour: number }>,
  tenants: string[] = [],
): Roster => ({
  activeUsers: async () => users,
  tenantsWithRunsBefore: async () => tenants,
});

describe('daily-run singleton', () => {
  it('a second enqueue for the same user and date is a no-op', async () => {
    await boss.createQueue(DAILY_RUN_JOB, { policy: 'exclusive' });
    const data = { tenantId: randomUUID(), userId: randomUUID(), date: TODAY };
    const first = await enqueueDailyRun(boss, data);
    const second = await enqueueDailyRun(boss, data);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    // a different day or user is a different key
    const other = await enqueueDailyRun(boss, { ...data, date: '2026-11-08' });
    expect(other).toBeTruthy();
    expect(dailyRunKey(data.userId, data.date)).toBe(`daily-run:${data.userId}:2026-11-07`);
    await boss.cancel(DAILY_RUN_JOB, [first!, other!]);
  });
});

describe('scheduler tick', () => {
  it('enqueues a run for every active user whose run hour is the current UTC hour, once', async () => {
    await boss.createQueue(DAILY_RUN_JOB, { policy: 'exclusive' });
    const mine = { tenantId: randomUUID(), userId: randomUUID(), runHour: NOW.getUTCHours() };
    const later = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      runHour: (NOW.getUTCHours() + 5) % 24,
    };
    const r = roster([mine, later]);
    const first = await enqueueScheduledRuns(boss, r, NOW);
    expect(first).toEqual({ date: TODAY, enqueued: 1, duplicates: 0 });
    const again = await enqueueScheduledRuns(boss, r, NOW);
    expect(again).toEqual({ date: TODAY, enqueued: 0, duplicates: 1 });
    const queued = await boss.fetch<{ userId: string; trigger: string }>(DAILY_RUN_JOB, {
      batchSize: 100,
    });
    const hit = queued.filter(
      (j) => j.data.userId === mine.userId || j.data.userId === later.userId,
    );
    expect(hit.map((j) => j.data.userId)).toEqual([mine.userId]);
    expect(hit[0]!.data).toMatchObject({
      tenantId: mine.tenantId,
      date: TODAY,
      trigger: 'scheduled',
    });
    if (queued.length)
      await boss.complete(
        DAILY_RUN_JOB,
        queued.map((j) => j.id),
      );
  });

  it('the production roster enumerates through the application connection (no owner credentials)', async () => {
    const t = await env.makeTenant();
    const unapproved = await env.makeTenant();
    await approveProfile(t.handle, t.userId, 5);
    // the application role cannot read users across tenants directly: row-level security needs
    // a tenant, so only the SECURITY DEFINER roster function can enumerate
    await expect(env.db.pool.query('select id from users')).rejects.toThrow();
    const roster = dbRoster(env.db);
    const users = await roster.activeUsers();
    expect(users).toContainEqual({ tenantId: t.id, userId: t.userId, runHour: 8 });
    expect(users.map((u) => u.userId)).not.toContain(unapproved.userId);
    // and it exposes nothing but ids and an hour
    expect(Object.keys(users[0]!).sort()).toEqual(['runHour', 'tenantId', 'userId']);

    const eight = new Date('2026-11-07T08:10:00Z');
    await boss.createQueue(DAILY_RUN_JOB, { policy: 'exclusive' });
    const tick = await enqueueScheduledRuns(boss, roster, eight);
    expect(tick.enqueued).toBeGreaterThanOrEqual(1);
    const queued = await boss.fetch<{ userId: string }>(DAILY_RUN_JOB, { batchSize: 1000 });
    expect(queued.map((j) => j.data.userId)).toContain(t.userId);
    expect(queued.map((j) => j.data.userId)).not.toContain(unapproved.userId);
    if (queued.length)
      await boss.complete(
        DAILY_RUN_JOB,
        queued.map((j) => j.id),
      );
  });

  it('registers an hourly tick and a nightly cleanup', async () => {
    // Its own client, stopped at once: a worker left running would consume other tests' jobs.
    const own = await freshBoss();
    try {
      await registerDailyRun(own, env.db, {
        roster: roster([]),
        llm: new FakeLlm([{}]),
        queue: fakeQueue(),
        adapters: [],
      });
      const names = (await own.getSchedules()).map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining([DAILY_RUN_TICK_JOB, DAILY_RUN_CLEANUP_JOB]));
    } finally {
      await own.stop({ graceful: false, timeout: 2000 });
    }
  });
});

describe('cleanup', () => {
  it('deletes runs older than 7 days with their candidates, and never touches jobs or applications', async () => {
    const t = await env.makeTenant();
    const mk = async (date: string) =>
      (await insertRun(t.handle, { userId: t.userId, date, targetN: 12, status: 'finished' })).run;
    const old = await mk('2026-10-30');
    const edge = await mk('2026-10-31'); // exactly 7 days old: kept
    const fresh = await mk(TODAY);
    await insertRunCandidates(t.handle, old.id, [
      { title: 'Old', companyName: 'X', url: 'https://jobs.lever.co/x/old' },
    ]);
    const { job } = await upsertJob(t.handle, { title: 'Old', url: 'https://jobs.lever.co/x/old' });
    const { application } = await insertApplication(t.handle, {
      userId: t.userId,
      jobId: job.id,
      runId: old.id,
    });

    // the production roster: tenants are found through wma_stale_runs on the application connection
    const r = await cleanupOldRuns(env.db, dbRoster(env.db), NOW);
    expect(r.cutoff).toBe('2026-10-31');
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await getRun(t.handle, old.id)).toBeNull();
    expect(await listRunCandidates(t.handle, old.id)).toEqual([]);
    expect(await getRun(t.handle, edge.id)).not.toBeNull();
    expect(await getRun(t.handle, fresh.id)).not.toBeNull();
    expect(await getApplication(t.handle, application.id)).toMatchObject({
      id: application.id,
      runId: null,
    });
  });
});

describe('worker handler', () => {
  it('a queued daily-run job is consumed and the run completes', async () => {
    const t = await env.makeTenant();
    await approveProfile(t.handle, t.userId, 5);
    const company = await upsertCompany(t.handle, {
      name: `E2E Co ${t.id.slice(0, 8)}`,
      ats: 'lever',
      boardSlug: `lw-${t.id.slice(0, 8)}`,
      createdBy: 'user',
    });
    await upsertUserCompany(t.handle, { userId: t.userId, companyId: company.id, source: 'user' });
    const jobs = [
      candidate({
        title: 'Platform Engineer',
        ats: 'lever',
        atsJobId: `e2e-${t.id.slice(0, 8)}`,
        url: `https://jobs.lever.co/lw/${t.id}`,
      }),
    ];
    const queue = fakeQueue();
    const own = await freshBoss();
    await registerDailyRun(own, env.db, {
      roster: roster([]),
      llm: new FakeLlm([judgment({ fit: 4 })]),
      queue,
      adapters: [staticAdapter('lever', jobs)],
      now: () => NOW,
      schedule: false,
    });
    await enqueueDailyRun(boss, {
      tenantId: t.id,
      userId: t.userId,
      date: TODAY,
      trigger: 'manual',
    });

    let run = await getRunForDate(t.handle, t.userId, TODAY);
    for (let i = 0; i < 80 && (!run || run.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 250));
      run = await getRunForDate(t.handle, t.userId, TODAY);
    }
    expect(run).toMatchObject({ status: 'short_day', trigger: 'manual', shortfall: 4 });
    expect(run!.counts).toMatchObject({ fetched: 1, selected: 1 });
    expect(queue.sent).toHaveLength(1);
    await own.stop({ graceful: false, timeout: 2000 });
  });
});
