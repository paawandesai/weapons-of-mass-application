import { describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { enqueueMailSyncs, mailSyncKey, MAIL_SYNC_JOB } from '../../src/jobs/mail-sync';

describe('mail-sync scheduler tick', () => {
  const users = [
    { tenantId: 't1', userId: 'u1' },
    { tenantId: 't2', userId: 'u2' },
  ];

  it('enqueues one job per approved user with the user as singleton key', async () => {
    const send = vi.fn(async () => 'job');
    const r = await enqueueMailSyncs({ send } as unknown as Pick<PgBoss, 'send'>, {
      users: async () => users,
    });
    expect(r).toEqual({ enqueued: 2, duplicates: 0 });
    const calls = send.mock.calls as unknown as Array<[string, unknown, Record<string, unknown>]>;
    expect(calls.map((c) => c[0])).toEqual([MAIL_SYNC_JOB, MAIL_SYNC_JOB]);
    expect(calls[0]![1]).toEqual(users[0]);
    expect(calls[0]![2]).toMatchObject({
      singletonKey: mailSyncKey('u1'),
      retryLimit: 5,
      retryBackoff: true,
    });
    expect(calls[1]![2]).toMatchObject({ singletonKey: mailSyncKey('u2') });
  });

  it('counts a user whose sync is still queued or running as a duplicate', async () => {
    const send = vi.fn(async (_n: string, data: unknown) =>
      (data as { userId: string }).userId === 'u1' ? null : 'job',
    );
    const r = await enqueueMailSyncs({ send } as unknown as Pick<PgBoss, 'send'>, {
      users: async () => users,
    });
    expect(r).toEqual({ enqueued: 1, duplicates: 1 });
  });
});
