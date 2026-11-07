import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { FOLLOW_UP_JOB, followUpDelayMs } from '../../src/submission/constants';
import { createFollowUpQueue, followUpStart } from '../../src/submission/followup';

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

describe('follow-up delay', () => {
  const DAY = 86_400_000;
  it('is seven days in real time', () => {
    expect(followUpDelayMs({})).toBe(7 * DAY);
    expect(followUpDelayMs({ GAUNTLET_TIME_SCALE: '1' })).toBe(7 * DAY);
    const applied = new Date('2026-11-07T18:00:00Z');
    expect(followUpStart(applied).getTime() - applied.getTime()).toBe(7 * DAY);
  });

  it('is compressed by GAUNTLET_TIME_SCALE for golden runs', () => {
    // 7 days / 10080 = 1 minute
    expect(followUpDelayMs({ GAUNTLET_TIME_SCALE: '10080' })).toBe(60_000);
  });

  it('refuses a scale that would send real follow-ups late or never', () => {
    expect(() => followUpDelayMs({ GAUNTLET_TIME_SCALE: '0.5' })).toThrow(/>= 1/);
    expect(() => followUpDelayMs({ GAUNTLET_TIME_SCALE: 'fast' })).toThrow(/>= 1/);
  });
});
