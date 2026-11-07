import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { profileDocumentSchema, type ProfileDocument } from '@wma/shared';
import fixture from '../../shared/test/fixtures/profile.full.json';
import { createDb, createUser, loadEnv, type Db, type TenantHandle } from '../src';

loadEnv();

/** Fixed 32-byte key (base64) so vault tests are deterministic and never use a real key. */
export const TEST_VAULT_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.VAULT_MASTER_KEY = TEST_VAULT_MASTER_KEY;

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
const appUrl = (() => {
  const u = new URL(ownerUrl);
  u.username = 'wma_app';
  u.password = process.env.APP_DB_PASSWORD || 'wma_app';
  return u.toString();
})();

export const doc: ProfileDocument = profileDocumentSchema.parse(fixture);

export interface TestEnv {
  db: Db;
  owner: pg.Pool;
  tenants: Array<{ id: string; handle: TenantHandle; userId: string }>;
  makeTenant(): Promise<{ id: string; handle: TenantHandle; userId: string }>;
  cleanup(): Promise<void>;
  appUrl: string;
}

/** Connects as the app role (RLS applies) plus an owner pool for setup and verification. */
export async function setupEnv(): Promise<TestEnv> {
  const owner = new pg.Pool({ connectionString: ownerUrl });
  try {
    await owner.query('select 1 from tenants limit 1');
  } catch (e) {
    throw new Error(
      `wma_test is not migrated (run scripts/db-test-reset.sh): ${(e as Error).message}`,
    );
  }
  const db = createDb(appUrl);
  const created: TestEnv['tenants'] = [];
  return {
    db,
    owner,
    tenants: created,
    appUrl,
    async makeTenant() {
      const id = await db.createTenant();
      const handle = db.forTenant(id);
      const tag = randomUUID();
      const user = await createUser(handle, {
        email: `${tag}@example.test`,
        googleSub: `sub-${tag}`,
        displayName: 'Test User',
      });
      const t = { id, handle, userId: user.id };
      created.push(t);
      return t;
    },
    async cleanup() {
      // Owner deletes; tenant FKs cascade (the app role cannot delete activity_log rows).
      if (created.length) {
        await owner.query('delete from tenants where id = any($1::uuid[])', [
          created.map((t) => t.id),
        ]);
      }
      await db.close();
      await owner.end();
    },
  };
}

/** Drizzle wraps driver errors ("Failed query"); the Postgres message is on `cause`. */
export async function pgErrorMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} | ${err.cause?.message ?? ''}`;
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

/** Inserts a job and a pending application for the tenant's user. */
export async function makeApplication(
  t: { handle: TenantHandle; userId: string },
  tag: string = randomUUID(),
) {
  const { upsertJob, insertApplication } = await import('../src');
  const { job } = await upsertJob(t.handle, {
    title: 'Engineer',
    url: `https://jobs.example.test/${tag}`,
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
  return { job, application };
}
