import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activity, insertProfileVersion, setApprovedProfileVersion } from '@wma/db';
import { profileDocumentSchema } from '@wma/shared';
import fixture from '../../../packages/shared/test/fixtures/profile.full.json';
import { guardedJob } from '../src/guarded';
import { setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

describe('guardedJob', () => {
  it('exits without running the handler and logs profile_not_approved for an unapproved user', async () => {
    const t = await env.makeTenant();
    const handler = vi.fn(async () => 'worked');
    const job = guardedJob('daily.run', handler);
    const out = await job({ handle: t.handle, userId: t.userId });
    expect(out).toEqual({ ran: false, reason: 'profile_not_approved' });
    expect(handler).not.toHaveBeenCalled();
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: 'profile_not_approved',
      actor: 'agent',
      detail: { job: 'daily.run' },
    });
  });

  it('a built-but-unapproved profile still does not run the job', async () => {
    const t = await env.makeTenant();
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: profileDocumentSchema.parse(fixture),
    });
    const handler = vi.fn(async () => 1);
    const out = await guardedJob('apply', handler)({ handle: t.handle, userId: t.userId });
    expect(out.ran).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler with the approved version once approved, and logs nothing extra', async () => {
    const t = await env.makeTenant();
    const doc = profileDocumentSchema.parse(fixture);
    await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
    await setApprovedProfileVersion(t.handle, t.userId, 1);
    await insertProfileVersion(t.handle, { userId: t.userId, document: doc }); // pending rebuild
    const handler = vi.fn(async (ctx: { approvedVersion: number }) => ctx.approvedVersion);
    const out = await guardedJob('apply', handler)({ handle: t.handle, userId: t.userId });
    expect(out).toEqual({ ran: true, result: 1 });
    expect(await activity.listByUser(t.handle, t.userId)).toHaveLength(0);
  });

  it('propagates handler errors', async () => {
    const t = await env.makeTenant();
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: profileDocumentSchema.parse(fixture),
    });
    await setApprovedProfileVersion(t.handle, t.userId, 1);
    await expect(
      guardedJob('x', async () => {
        throw new Error('boom');
      })({ handle: t.handle, userId: t.userId }),
    ).rejects.toThrow('boom');
  });
});
