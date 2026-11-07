import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { FOLLOW_UP_JOB } from '../../src/submission/constants';
import { createFollowUpQueue } from '../../src/submission/followup';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
let boss: PgBoss;
beforeAll(async () => {
  boss = new PgBoss(ownerUrl);
  boss.on('error', () => {});
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false, timeout: 2000 });
});

describe('follow-up queue', () => {
  it('enqueues once per application, delayed, even when asked twice', async () => {
    const queue = createFollowUpQueue(boss);
    const data = { tenantId: randomUUID(), userId: randomUUID(), applicationId: randomUUID() };
    const startAfter = new Date(Date.now() + 7 * 86_400_000);
    await queue.enqueueFollowUp(data, startAfter);
    await queue.enqueueFollowUp(data, startAfter);
    const job = await boss.getJobById(FOLLOW_UP_JOB, data.applicationId);
    expect(job).toMatchObject({ data, state: 'created' });
    expect(Math.abs(new Date(job!.startAfter).getTime() - startAfter.getTime())).toBeLessThan(2000);
    const mine = (await boss.fetch<typeof data>(FOLLOW_UP_JOB, { batchSize: 100 })).filter(
      (j) => j.data.applicationId === data.applicationId,
    );
    // Not due for seven days, so nothing can claim it yet.
    expect(mine).toHaveLength(0);
    const pool = new pg.Pool({ connectionString: ownerUrl });
    try {
      const rows = await pool.query(
        'select count(*)::int as n from pgboss.job where name = $1 and (data->>$2) = $3',
        [FOLLOW_UP_JOB, 'applicationId', data.applicationId],
      );
      expect(rows.rows[0].n).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
