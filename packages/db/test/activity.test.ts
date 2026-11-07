import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, ActivityRedactionError } from '../src';
import { makeApplication, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

describe('activity log', () => {
  it('appends and reads newest first with limit and cursor', async () => {
    const t = await env.makeTenant();
    for (const action of ['a', 'b', 'c']) {
      await activity.logActivity(t.handle, {
        userId: t.userId,
        actor: 'agent',
        action,
        detail: { n: action },
      });
    }
    const all = await activity.listByUser(t.handle, t.userId, {});
    expect(all.map((e) => e.action)).toEqual(['c', 'b', 'a']);
    expect(all[0]).toMatchObject({ actor: 'agent', detail: { n: 'c' }, applicationId: null });
    const two = await activity.listByUser(t.handle, t.userId, { limit: 2 });
    expect(two.map((e) => e.action)).toEqual(['c', 'b']);
    const older = await activity.listByUser(t.handle, t.userId, { before: two[1]!.cursor });
    expect(older.map((e) => e.action)).toEqual(['a']);
  });

  it('pages through entries that share a millisecond or a timestamp, without skipping or repeating', async () => {
    const t = await env.makeTenant();
    // Microsecond-apart timestamps inside one millisecond, plus a pair with identical timestamps.
    const stamps = [
      '2026-01-01 00:00:00.000100+00',
      '2026-01-01 00:00:00.000200+00',
      '2026-01-01 00:00:00.000300+00',
      '2026-01-01 00:00:00.000300+00',
      '2026-01-01 00:00:00.000900+00',
    ];
    for (const [i, at] of stamps.entries()) {
      await env.owner.query(
        `insert into activity_log (tenant_id, user_id, at, actor, action) values ($1, $2, $3::timestamptz, 'agent', $4)`,
        [t.id, t.userId, at, `e${i}`],
      );
    }
    const everything = await activity.listByUser(t.handle, t.userId, {});
    expect(everything).toHaveLength(5);
    const paged: string[] = [];
    let cursor: activity.ActivityCursor | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await activity.listByUser(t.handle, t.userId, { limit: 1, before: cursor });
      if (page.length === 0) break;
      paged.push(page[0]!.id);
      cursor = page[0]!.cursor;
    }
    expect(paged).toEqual(everything.map((e) => e.id));
    expect(new Set(paged).size).toBe(5);
    const byApp = await activity.listByApplication(t.handle, crypto.randomUUID(), {});
    expect(byApp).toEqual([]);
  });

  it('filters by application', async () => {
    const t = await env.makeTenant();
    const app1 = (await makeApplication(t)).application.id;
    await activity.logActivity(t.handle, { userId: t.userId, actor: 'user', action: 'x' });
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: app1,
      actor: 'agent',
      action: 'y',
    });
    const rows = await activity.listByApplication(t.handle, app1);
    expect(rows.map((e) => e.action)).toEqual(['y']);
  });

  it('returns empty for another tenant', async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    await activity.logActivity(a.handle, { userId: a.userId, actor: 'agent', action: 'x' });
    expect(await activity.listByUser(b.handle, a.userId, {})).toEqual([]);
  });

  it('rejects secret-looking keys at any depth and writes nothing', async () => {
    const t = await env.makeTenant();
    const bad: Array<Record<string, unknown>> = [
      { token: 'x' },
      { Password: 'x' },
      { client_secret: 'x' },
      { outer: { access_token: 'x' } },
      { list: [{ deep: { refreshToken: 'x' } }] },
    ];
    for (const detail of bad) {
      await expect(
        activity.logActivity(t.handle, { userId: t.userId, actor: 'agent', action: 'z', detail }),
      ).rejects.toBeInstanceOf(ActivityRedactionError);
    }
    expect(await activity.listByUser(t.handle, t.userId, {})).toEqual([]);
    // A secret-looking value (not key) is allowed: the log stores references.
    await activity.logActivity(t.handle, {
      userId: t.userId,
      actor: 'agent',
      action: 'token_refresh',
      detail: { provider: 'google', outcome: 'ok' },
    });
    expect(await activity.listByUser(t.handle, t.userId, {})).toHaveLength(1);
  });

  it('is append-only for the app role', async () => {
    const t = await env.makeTenant();
    await activity.logActivity(t.handle, { userId: t.userId, actor: 'agent', action: 'x' });
    await expect(
      t.handle.run((tx) => tx.execute(sql`update activity_log set action = 'y'`)),
    ).rejects.toThrow();
  });
});
