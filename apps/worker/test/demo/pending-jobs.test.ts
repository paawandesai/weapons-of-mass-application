import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertPendingJob, listUndispatchedJobs } from '@wma/db';
import { runSimulatedRecruiter } from '../../src/demo/recruiter';
import { dispatchAllPendingJobs, dispatchPendingJobs } from '../../src/jobs/pending-jobs';
import { runSimulatedRecruiterTick } from '../../src/jobs/simulated-recruiter';
import { appliedTo, setupDemoEnv, type DemoEnv } from './support';

let env: DemoEnv;
let userId: string;
beforeAll(async () => {
  env = await setupDemoEnv();
  userId = env.summary.userId;
});
afterAll(async () => {
  await env.cleanup();
});

type Sent = { name: string; data: unknown; options: Record<string, unknown> };
const fakeBoss = (fail = false, result: string | null = 'job-1') => {
  const sent: Sent[] = [];
  return {
    sent,
    async send(name: string, data: unknown, options: Record<string, unknown>) {
      if (fail) throw new Error('queue down');
      sent.push({ name, data, options });
      return result;
    },
  };
};

describe('mail sync after a simulated delivery', () => {
  it('commits a mail-sync row with the message, and a failed send leaves it for the next pass', async () => {
    const job = await env.jobsByTitle('Staff Software Engineer, Scheduling');
    const app = await appliedTo(env.handle, userId, job.id);
    const r = await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    expect(r.delivered.map((d) => d.applicationId)).toContain(app.id);

    const owed = (await listUndispatchedJobs(env.handle)).filter((p) => p.kind === 'mail-sync');
    expect(owed.map((p) => p.dedupeKey)).toContain(`mail-sync:sim-proposal-${app.id}`);

    // The queue is down: the row stays owed.
    const down = fakeBoss(true);
    expect(await dispatchPendingJobs(env.handle, down as never)).toBe(0);
    expect((await listUndispatchedJobs(env.handle)).length).toBe(owed.length);

    // A later pass delivers nothing new (the message exists) yet still sends the sync.
    const up = fakeBoss();
    const again = await runSimulatedRecruiter(env.handle, userId, { delayMs: 0 });
    expect(again.delivered).toEqual([]);
    expect(await dispatchPendingJobs(env.handle, up as never)).toBe(owed.length);
    expect(up.sent[0]).toMatchObject({
      name: 'mail-sync',
      data: { tenantId: env.summary.tenantId, userId },
      options: { singletonKey: `mail-sync:${userId}` },
    });
    expect(await listUndispatchedJobs(env.handle)).toEqual([]);
  });

  it('the recruiter tick sends the owed sync even when it delivers nothing', async () => {
    await insertPendingJob(env.handle, {
      userId,
      kind: 'mail-sync',
      payload: { tenantId: env.summary.tenantId, userId },
      dedupeKey: 'mail-sync:manual-test',
    });
    const boss = fakeBoss();
    const db = {
      demoUser: async () => ({ tenantId: env.summary.tenantId, userId }),
      forTenant: env.db.forTenant,
    };
    await runSimulatedRecruiterTick(boss as never, db, { immediate: true }, 0);
    expect(boss.sent.filter((s) => s.name === 'mail-sync')).toHaveLength(1);
    expect(await listUndispatchedJobs(env.handle)).toEqual([]);
  });

  it('keeps a mail-sync row when an identical sync is already queued', async () => {
    await insertPendingJob(env.handle, {
      userId,
      kind: 'mail-sync',
      payload: { tenantId: env.summary.tenantId, userId },
      dedupeKey: 'mail-sync:busy',
    });
    expect(await dispatchPendingJobs(env.handle, fakeBoss(false, null) as never)).toBe(0);
    expect((await listUndispatchedJobs(env.handle)).map((p) => p.dedupeKey)).toEqual([
      'mail-sync:busy',
    ]);
    expect(await dispatchPendingJobs(env.handle, fakeBoss() as never)).toBe(1);
  });
});

describe('the reconciler', () => {
  it('finds tenants with owed rows, sends other kinds under their dedupe key and is idempotent', async () => {
    const first = await insertPendingJob(env.handle, {
      userId,
      kind: 'prep-plan',
      payload: { tenantId: env.summary.tenantId, userId, interviewId: 'i-1' },
      dedupeKey: 'prep-plan:i-1',
    });
    const dup = await insertPendingJob(env.handle, {
      userId,
      kind: 'prep-plan',
      payload: {},
      dedupeKey: 'prep-plan:i-1',
    });
    expect(dup.id).toBe(first.id);
    expect(await env.db.tenantsWithPendingJobs()).toContain(env.summary.tenantId);

    const boss = fakeBoss(false, null);
    expect(await dispatchAllPendingJobs(env.db, boss as never)).toBe(1);
    expect(boss.sent[0]).toMatchObject({
      name: 'prep-plan',
      options: { singletonKey: 'prep-plan:i-1' },
    });
    expect(await env.db.tenantsWithPendingJobs()).not.toContain(env.summary.tenantId);
    expect(await dispatchAllPendingJobs(env.db, boss as never)).toBe(0);
  });
});
