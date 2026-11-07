import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
// The queue module reads DATABASE_URL lazily on first use; point it at the test database.
process.env.DATABASE_URL = ownerUrl;

let reader: PgBoss;
beforeAll(async () => {
  reader = new PgBoss(ownerUrl);
  reader.on('error', () => {});
  await reader.start();
});
afterAll(async () => {
  await reader.stop({ graceful: false, timeout: 2000 });
});

describe('pgBossQueue', () => {
  it('enqueues a profile.build job carrying tenant, user and build ids', async () => {
    const { pgBossQueue, PROFILE_BUILD_JOB } = await import('../src/services/queue');
    await reader.createQueue(PROFILE_BUILD_JOB);
    const data = { tenantId: randomUUID(), userId: randomUUID(), buildId: randomUUID() };
    await pgBossQueue.enqueueProfileBuild(data);
    const jobs = await reader.fetch<typeof data>(PROFILE_BUILD_JOB, { batchSize: 50 });
    const mine = jobs.find((j) => j.data.buildId === data.buildId);
    expect(mine?.data).toEqual(data);
    // The job id is the build id, so its state can be looked up later.
    expect(await pgBossQueue.jobState(data.buildId)).toBe('active');
    expect(await pgBossQueue.jobState(randomUUID())).toBeNull();
    if (jobs.length)
      await reader.complete(
        PROFILE_BUILD_JOB,
        jobs.map((j) => j.id),
      );
    expect(await pgBossQueue.jobState(data.buildId)).toBe('completed');
  }, 30000);
});
