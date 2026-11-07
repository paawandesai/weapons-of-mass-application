import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NotFoundError,
  activity,
  startProfileBuild,
  upsertConnection,
  vault,
  ProfileNotApprovedError,
  createSession,
  createUser,
  getCurrentTenant,
  getLatestProfile,
  getProfileVersion,
  getSession,
  getUserById,
  insertProfileVersion,
  listUsers,
  requireApprovedProfile,
  schema,
  setApprovedProfileVersion,
  touchSession,
  deleteSession,
} from '../src';
import { doc, pgErrorMessage, setupEnv, type TestEnv } from './helpers';
import { sql } from 'drizzle-orm';

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

describe('role and RLS configuration (rules 3, 4)', () => {
  it('app role is not superuser, not bypassrls, and owns no tenant table', async () => {
    const r = await A.handle.run(async (tx) =>
      tx.execute(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`),
    );
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const owned = await env.owner.query(
      `select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = 'wma_app'`,
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it('every tenant table has RLS enabled and forced and four policies', async () => {
    const r = await env.owner.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(distinct p.cmd) from pg_policies p where p.tablename = c.relname) as cmds
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    // companies is the global ATS board cache: no tenant_id, deliberately without RLS.
    const tenantTables = r.rows.filter((x) => x.relname !== 'companies');
    const names = tenantTables.map((x) => x.relname).sort();
    expect(names).toEqual(
      [
        'activity_log',
        'applications',
        'ats_credentials',
        'captcha_requests',
        'demo_calendar_events',
        'demo_mailbox_messages',
        'digest_state',
        'email_threads',
        'interview_slots',
        'interviews',
        'jobs',
        'llm_usage',
        'mail_sync_state',
        'outgoing_messages',
        'pending_jobs',
        'processed_messages',
        'profile_builds',
        'profiles',
        'run_candidates',
        'runs',
        'secrets',
        'sessions',
        'source_connections',
        'stage_overrides',
        'tenants',
        'user_companies',
        'users',
        'vault_keys',
      ].sort(),
    );
    const companiesRow = r.rows.find((x) => x.relname === 'companies');
    expect(companiesRow?.relrowsecurity).toBe(false);
    for (const row of tenantTables) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      expect(Number(row.cmds), row.relname).toBe(4);
    }
  });
});

describe('tenant stamping and forged ids (rule 6)', () => {
  it('repository stamps tenant_id from the handle and ignores a caller-supplied value', async () => {
    const tag = randomUUID();
    const forged = { email: `${tag}@x.test`, googleSub: tag, tenantId: B.id } as never;
    const user = await createUser(A.handle, forged);
    expect(user.tenantId).toBe(A.id);
    const row = await env.owner.query('select tenant_id from users where id = $1', [user.id]);
    expect(row.rows[0].tenant_id).toBe(A.id);
  });

  it('a raw insert under the handle carrying another tenant_id fails at the RLS policy', async () => {
    const tag = randomUUID();
    expect(
      await pgErrorMessage(
        A.handle.run((tx) =>
          tx
            .insert(schema.users)
            .values({ tenantId: B.id, email: `${tag}@x.test`, googleSub: tag }),
        ),
      ),
    ).toMatch(/row-level security|violates/i);
  });

  it('a session or profile for a user of another tenant is rejected', async () => {
    await expect(
      createSession(A.handle, { id: randomUUID(), userId: B.userId, expiresAt: new Date() }),
    ).rejects.toThrow();
    await expect(
      insertProfileVersion(A.handle, { userId: B.userId, document: doc }),
    ).rejects.toThrow();
  });
});

describe('cross-tenant reads (rule 7)', () => {
  it('another tenant user by id is not_found, same as a nonexistent id', async () => {
    const cross = await getUserById(A.handle, B.userId).catch((e) => e);
    const missing = await getUserById(A.handle, randomUUID()).catch((e) => e);
    expect(cross).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(cross.code).toBe('not_found');
    expect(cross.message).toBe(missing.message);
  });

  it('sessions and profiles of another tenant are not_found', async () => {
    const sid = randomUUID();
    await createSession(B.handle, {
      id: sid,
      userId: B.userId,
      expiresAt: new Date(Date.now() + 1e6),
    });
    await insertProfileVersion(B.handle, { userId: B.userId, document: doc });
    await expect(getSession(A.handle, sid)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProfileVersion(A.handle, B.userId, 1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLatestProfile(A.handle, B.userId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(touchSession(A.handle, sid, new Date())).rejects.toBeInstanceOf(NotFoundError);
    await deleteSession(A.handle, sid); // silently affects nothing
    await expect(getSession(B.handle, sid)).resolves.toMatchObject({ id: sid });
  });

  it('getCurrentTenant returns only the handle tenant', async () => {
    expect((await getCurrentTenant(A.handle)).id).toBe(A.id);
  });
});

describe('the RLS backstop (rules 2, 3, failure handling)', () => {
  it('raw SQL under the handle without a where clause sees exactly its own rows in every table', async () => {
    const seed = async (t: typeof A) => {
      await createSession(t.handle, {
        id: `s-${randomUUID()}`,
        userId: t.userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
      await upsertConnection(t.handle, { userId: t.userId, kind: 'github', config: { n: t.id } });
      await startProfileBuild(t.handle, t.userId);
      await activity.logActivity(t.handle, { userId: t.userId, actor: 'user', action: 'seed' });
      // Creates the tenant's vault_keys row and one secrets row.
      await vault.put(t.handle, t.userId, 'ats_password', `seed:${t.id}`, 'pw');
    };
    await seed(A);
    await seed(B);

    const tables = [
      'tenants',
      'users',
      'sessions',
      'profiles',
      'source_connections',
      'activity_log',
      'profile_builds',
      'secrets',
      'vault_keys',
    ];
    for (const table of tables) {
      const col = table === 'tenants' ? 'id' : 'tenant_id';
      for (const [me, other] of [
        [A, B],
        [B, A],
      ] as const) {
        const expected = (
          await env.owner.query<{ id: string }>(`select id from ${table} where ${col} = $1`, [
            me.id,
          ])
        ).rows
          .map((r) => r.id)
          .sort();
        const foreign = (
          await env.owner.query<{ id: string }>(`select id from ${table} where ${col} = $1`, [
            other.id,
          ])
        ).rows.map((r) => r.id);
        expect(expected.length, `${table} seeded for own tenant`).toBeGreaterThan(0);
        expect(foreign.length, `${table} seeded for other tenant`).toBeGreaterThan(0);
        const r = await me.handle.run((tx) => tx.execute(sql.raw(`select id from ${table}`)));
        const seen = r.rows.map((x) => x.id as string).sort();
        expect(seen, table).toEqual(expected);
      }
    }
    const users = await A.handle.run((tx) => tx.execute(sql`select id from users`));
    expect(users.rows.map((r) => r.id)).toContain(A.userId);
    expect(users.rows.map((r) => r.id)).not.toContain(B.userId);
    expect((await listUsers(B.handle)).some((r) => r.id === B.userId)).toBe(true);
  });

  it('update and delete of another tenant row affect nothing', async () => {
    const upd = await A.handle.run((tx) =>
      tx.execute(sql`update users set display_name = 'pwned' where id = ${B.userId}::uuid`),
    );
    expect(upd.rowCount).toBe(0);
    const del = await A.handle.run((tx) =>
      tx.execute(sql`delete from users where id = ${B.userId}::uuid`),
    );
    expect(del.rowCount).toBe(0);
    expect((await getUserById(B.handle, B.userId)).displayName).toBe('Test User');
  });

  it('a query with no app.tenant_id set fails loudly instead of returning empty', async () => {
    const client = new pg.Client({ connectionString: env.appUrl });
    await client.connect();
    try {
      await expect(client.query('select * from users')).rejects.toThrow(/app\.tenant_id/);
    } finally {
      await client.end();
    }
  });

  it('forTenant rejects a non-uuid id', () => {
    expect(() => env.db.forTenant("x'; drop table users; --")).toThrow(TypeError);
  });

  it('handle.transaction runs several calls under one tenant setting', async () => {
    const n = await A.handle.transaction(async (h) => {
      const u = await getUserById(h, A.userId);
      const t = await getCurrentTenant(h);
      return u.tenantId === t.id ? 1 : 0;
    });
    expect(n).toBe(1);
  });
});

describe('activity_log is append-only for the app role (rule 8)', () => {
  it('insert and select work; update and delete fail', async () => {
    await A.handle.run((tx) =>
      tx.insert(schema.activityLog).values({
        tenantId: A.id,
        userId: A.userId,
        actor: 'test',
        action: 'unit_test',
      }),
    );
    const rows = await A.handle.run((tx) => tx.select().from(schema.activityLog));
    expect(rows.length).toBeGreaterThan(0);
    expect(
      await pgErrorMessage(
        A.handle.run((tx) => tx.execute(sql`update activity_log set action = 'x'`)),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await pgErrorMessage(A.handle.run((tx) => tx.execute(sql`delete from activity_log`))),
    ).toMatch(/permission denied/i);
  });

  it('an entry for another tenant user cannot be written', async () => {
    await expect(
      A.handle.run((tx) =>
        tx.insert(schema.activityLog).values({
          tenantId: A.id,
          userId: B.userId,
          actor: 'test',
          action: 'unit_test',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('unique indexes', () => {
  it('vault_keys per tenant, secrets per (tenant, kind, ref), profiles per (user, version)', async () => {
    const A = await env.makeTenant();
    const B = await env.makeTenant();
    const bytes = Buffer.from('x');
    const key = { tenantId: A.id, wrappedDek: bytes, wrapIv: bytes, wrapTag: bytes };
    await A.handle.run((tx) => tx.insert(schema.vaultKeys).values(key));
    expect(
      await pgErrorMessage(A.handle.run((tx) => tx.insert(schema.vaultKeys).values(key))),
    ).toMatch(/duplicate key/i);
    const secret = {
      tenantId: A.id,
      kind: 'ats_password' as const,
      ref: 'greenhouse:acme',
      ciphertext: bytes,
      iv: bytes,
      tag: bytes,
    };
    await A.handle.run((tx) => tx.insert(schema.secrets).values(secret));
    expect(
      await pgErrorMessage(A.handle.run((tx) => tx.insert(schema.secrets).values(secret))),
    ).toMatch(/duplicate key/i);
    // Same ref in the other tenant is an independent row.
    await B.handle.run((tx) => tx.insert(schema.secrets).values({ ...secret, tenantId: B.id }));
    const p = await insertProfileVersion(A.handle, { userId: A.userId, document: doc });
    expect(
      await pgErrorMessage(
        A.handle.run((tx) =>
          tx.insert(schema.profiles).values({
            tenantId: A.id,
            userId: A.userId,
            version: p.version,
            document: doc,
          }),
        ),
      ),
    ).toMatch(/duplicate key/i);
  });
});

describe('requireApprovedProfile (rules 9, 10)', () => {
  it('throws profile_not_approved for a user with no approved version', async () => {
    const t = await env.makeTenant();
    await expect(requireApprovedProfile(t.handle, t.userId)).rejects.toBeInstanceOf(
      ProfileNotApprovedError,
    );
    await expect(requireApprovedProfile(t.handle, t.userId)).rejects.toMatchObject({
      code: 'profile_not_approved',
    });
    // A saved but unapproved version is still not approved.
    await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
    await expect(requireApprovedProfile(t.handle, t.userId)).rejects.toBeInstanceOf(
      ProfileNotApprovedError,
    );
  });

  it('returns the approved version, and a rebuild does not move it', async () => {
    const t = await env.makeTenant();
    const v1 = await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
    expect(v1.version).toBe(1);
    await setApprovedProfileVersion(t.handle, t.userId, 1);
    expect(await requireApprovedProfile(t.handle, t.userId)).toBe(1);
    const v2 = await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
    expect(v2.version).toBe(2);
    expect(await requireApprovedProfile(t.handle, t.userId)).toBe(1);
    expect((await getUserById(t.handle, t.userId)).approvedProfileVersion).toBe(1);
    expect((await getProfileVersion(t.handle, t.userId, 1)).version).toBe(1);
    expect((await getLatestProfile(t.handle, t.userId)).version).toBe(2);
  });

  it('cannot approve a version that does not exist', async () => {
    const t = await env.makeTenant();
    await expect(setApprovedProfileVersion(t.handle, t.userId, 7)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('treats an approved pointer whose version row was deleted as not approved', async () => {
    const t = await env.makeTenant();
    await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
    await setApprovedProfileVersion(t.handle, t.userId, 1);
    await env.owner.query('delete from profiles where user_id = $1', [t.userId]);
    await expect(requireApprovedProfile(t.handle, t.userId)).rejects.toBeInstanceOf(
      ProfileNotApprovedError,
    );
  });

  it('treats another tenant user as not approved', async () => {
    const t = await env.makeTenant();
    await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
    await setApprovedProfileVersion(t.handle, t.userId, 1);
    await expect(requireApprovedProfile(A.handle, t.userId)).rejects.toBeInstanceOf(
      ProfileNotApprovedError,
    );
  });
});

describe('pre-tenant lookups', () => {
  it('resolveSession maps a session id to its tenant and user; unknown id gives null', async () => {
    const sid = `s-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3_600_000);
    await createSession(A.handle, { id: sid, userId: A.userId, expiresAt });
    const got = await env.db.resolveSession(sid);
    expect(got).toMatchObject({ tenantId: A.id, userId: A.userId });
    expect(await env.db.resolveSession('nope')).toBeNull();
  });

  it('findUserIdentity matches by google sub only, never by email', async () => {
    const u = await getUserById(A.handle, A.userId);
    expect(await env.db.findUserIdentity(u.googleSub)).toEqual({
      tenantId: A.id,
      userId: A.userId,
    });
    expect(await env.db.findUserIdentity('none')).toBeNull();
    // The email of an existing user is not an identity.
    expect(await env.db.findUserIdentity(u.email)).toBeNull();
  });

  it('emailExists reports a stored email without exposing the owner', async () => {
    const u = await getUserById(A.handle, A.userId);
    expect(await env.db.emailExists(u.email)).toBe(true);
    expect(await env.db.emailExists('nobody@x.test')).toBe(false);
  });

  it('the app role cannot read tables directly without a tenant', async () => {
    const client = new pg.Client({ connectionString: env.appUrl });
    await client.connect();
    try {
      await expect(client.query('select * from sessions')).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
