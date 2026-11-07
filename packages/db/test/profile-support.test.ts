import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  disconnectConnection,
  finishProfileBuild,
  getConnection,
  getLatestProfileBuild,
  getUserById,
  insertProfileVersion,
  listActiveConnections,
  lockRunningBuild,
  reserveProfileBuild,
  setApprovedProfileVersion,
  setDailyTarget,
  startProfileBuild,
  updateConnection,
  upsertConnection,
} from '../src';
import { doc, pgErrorMessage, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
let A: Awaited<ReturnType<TestEnv['makeTenant']>>;
let B: Awaited<ReturnType<TestEnv['makeTenant']>>;

beforeAll(async () => {
  env = await setupEnv();
  A = await env.makeTenant();
  B = await env.makeTenant();
});
afterAll(async () => {
  await env.cleanup();
});

describe('approved_profile_at', () => {
  it('is null until approval, then stamped with the version', async () => {
    expect((await getUserById(A.handle, A.userId)).approvedProfileAt).toBeNull();
    await insertProfileVersion(A.handle, { userId: A.userId, document: doc });
    const before = Date.now();
    const u = await setApprovedProfileVersion(A.handle, A.userId, 1);
    expect(u.approvedProfileVersion).toBe(1);
    expect(u.approvedProfileAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a rebuild does not change it', async () => {
    const at = (await getUserById(A.handle, A.userId)).approvedProfileAt;
    await insertProfileVersion(A.handle, { userId: A.userId, document: doc });
    const u = await getUserById(A.handle, A.userId);
    expect(u.approvedProfileVersion).toBe(1);
    expect(u.approvedProfileAt).toEqual(at);
  });

  it('setDailyTarget updates the user row', async () => {
    expect((await setDailyTarget(A.handle, A.userId, 20)).dailyTarget).toBe(20);
  });
});

describe('source_connections repository', () => {
  it('upserts one row per kind, reconnect clears disconnected_at, disconnect returns the file ref', async () => {
    const a = await upsertConnection(A.handle, {
      userId: A.userId,
      kind: 'resume',
      config: { text: 'x' },
      fileRef: 't/u/resume.pdf',
    });
    const b = await upsertConnection(A.handle, {
      userId: A.userId,
      kind: 'resume',
      config: { text: 'y' },
      fileRef: 't/u/resume.docx',
    });
    expect(b.id).toBe(a.id);
    expect(b.config).toEqual({ text: 'y' });
    const gone = await disconnectConnection(A.handle, A.userId, 'resume');
    expect(gone?.fileRef).toBe('t/u/resume.docx');
    const row = await getConnection(A.handle, A.userId, 'resume');
    expect(row).toMatchObject({ status: 'disconnected', fileRef: null, config: {} });
    expect(row?.disconnectedAt).toBeInstanceOf(Date);
    expect(await listActiveConnections(A.handle, A.userId)).toEqual([]);
    const again = await upsertConnection(A.handle, {
      userId: A.userId,
      kind: 'resume',
      config: { text: 'z' },
    });
    expect(again.disconnectedAt).toBeNull();
    expect(await disconnectConnection(A.handle, A.userId, 'github')).toBeNull();
  });

  it('updateConnection merges config; other tenants cannot see the row', async () => {
    await upsertConnection(A.handle, { userId: A.userId, kind: 'drive', config: { a: 1 } });
    const u = await updateConnection(A.handle, A.userId, 'drive', { config: { b: 2 } });
    expect(u?.config).toEqual({ a: 1, b: 2 });
    expect(await getConnection(B.handle, A.userId, 'drive')).toBeNull();
    expect(await updateConnection(B.handle, B.userId, 'drive', { config: {} })).toBeNull();
  });
});

describe('concurrent writers', () => {
  it('parallel profile inserts get consecutive versions with no unique violation', async () => {
    const t = await env.makeTenant();
    const rows = await Promise.all(
      Array.from({ length: 8 }, () =>
        insertProfileVersion(t.handle, { userId: t.userId, document: doc }),
      ),
    );
    expect(rows.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('parallel first connections of one kind leave exactly one row', async () => {
    const t = await env.makeTenant();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertConnection(t.handle, { userId: t.userId, kind: 'github', config: { n: i } }),
      ),
    );
    const r = await env.owner.query(
      `select count(*)::int as n from source_connections where user_id = $1 and kind = 'github'`,
      [t.userId],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it('the database refuses a second source_connections row for (tenant, user, kind)', async () => {
    const t = await env.makeTenant();
    await upsertConnection(t.handle, { userId: t.userId, kind: 'linkedin', config: {} });
    const msg = await pgErrorMessage(
      t.handle.run((tx) =>
        tx.execute(
          sql`insert into source_connections (tenant_id, user_id, kind) values (${t.id}::uuid, ${t.userId}::uuid, 'linkedin')`,
        ),
      ),
    );
    expect(msg).toMatch(/duplicate key/i);
  });

  it('parallel build reservations create exactly one running build and agree on its id', async () => {
    const t = await env.makeTenant();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveProfileBuild(t.handle, t.userId)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.build.id)).size).toBe(1);
    const running = await env.owner.query(
      `select count(*)::int as n from profile_builds where user_id = $1 and state = 'running'`,
      [t.userId],
    );
    expect(running.rows[0].n).toBe(1);
  });
});

describe('profile_builds', () => {
  it('a finished build releases the reservation and finishing twice is a no-op', async () => {
    const t = await env.makeTenant();
    const first = await reserveProfileBuild(t.handle, t.userId);
    expect(first.created).toBe(true);
    expect(await lockRunningBuild(t.handle, first.build.id)).toBe(true);
    expect(
      await finishProfileBuild(t.handle, first.build.id, { state: 'done', version: 1 }),
    ).not.toBeNull();
    // Fenced: a build that is no longer running cannot be finished (or locked) again.
    expect(await lockRunningBuild(t.handle, first.build.id)).toBe(false);
    expect(
      await finishProfileBuild(t.handle, first.build.id, { state: 'failed', reason: 'late' }),
    ).toBeNull();
    expect(await getLatestProfileBuild(t.handle, t.userId)).toMatchObject({ state: 'done' });
    const second = await reserveProfileBuild(t.handle, t.userId);
    expect(second.created).toBe(true);
    expect(second.build.id).not.toBe(first.build.id);
  });

  it('tracks running, done and failed; the latest wins', async () => {
    expect(await getLatestProfileBuild(A.handle, A.userId)).toBeNull();
    const first = await startProfileBuild(A.handle, A.userId);
    expect(first.state).toBe('running');
    await finishProfileBuild(A.handle, first.id, { state: 'done', version: 4 });
    expect(await getLatestProfileBuild(A.handle, A.userId)).toMatchObject({
      state: 'done',
      version: 4,
    });
    const second = await startProfileBuild(A.handle, A.userId);
    await finishProfileBuild(A.handle, second.id, {
      state: 'failed',
      reason: 'profile_build_no_resume',
    });
    const latest = await getLatestProfileBuild(A.handle, A.userId);
    expect(latest).toMatchObject({
      state: 'failed',
      reason: 'profile_build_no_resume',
      version: null,
    });
    expect(latest?.finishedAt).toBeInstanceOf(Date);
  });

  it('RLS: raw SQL under another tenant sees nothing, and a forged tenant_id insert fails', async () => {
    const rows = await B.handle.run((tx) => tx.execute(sql`select * from profile_builds`));
    expect(rows.rows).toHaveLength(0);
    const msg = await pgErrorMessage(
      B.handle.run((tx) =>
        tx.execute(
          sql`insert into profile_builds (tenant_id, user_id) values (${A.id}::uuid, ${A.userId}::uuid)`,
        ),
      ),
    );
    expect(msg).toMatch(/row-level security|violates/i);
  });

  it('the forgotten-set-local backstop: no app.tenant_id fails loudly', async () => {
    const msg = await pgErrorMessage(env.db.pool.query('select * from profile_builds'));
    expect(msg).toMatch(
      /app\.tenant_id|unrecognized configuration|invalid input syntax for type uuid/i,
    );
  });
});
