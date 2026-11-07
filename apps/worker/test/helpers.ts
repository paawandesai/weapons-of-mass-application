import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  createDb,
  createUser,
  loadEnv,
  upsertConnection,
  type Db,
  type SourceKind,
  type TenantHandle,
} from '@wma/db';

loadEnv();

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
const appUrl = (() => {
  const u = new URL(ownerUrl);
  u.username = 'wma_app';
  u.password = process.env.APP_DB_PASSWORD || 'wma_app';
  return u.toString();
})();

export interface TestTenant {
  id: string;
  handle: TenantHandle;
  userId: string;
  email: string;
}

export interface TestEnv {
  db: Db;
  makeTenant(): Promise<TestTenant>;
  cleanup(): Promise<void>;
}

export async function setupEnv(): Promise<TestEnv> {
  const owner = new pg.Pool({ connectionString: ownerUrl });
  const db = createDb(appUrl);
  const ids: string[] = [];
  return {
    db,
    async makeTenant() {
      const id = await db.createTenant();
      ids.push(id);
      const handle = db.forTenant(id);
      const tag = randomUUID();
      const email = `${tag}@example.test`;
      const user = await createUser(handle, {
        email,
        googleSub: `sub-${tag}`,
        displayName: 'Mara Quill',
      });
      return { id, handle, userId: user.id, email };
    },
    async cleanup() {
      if (ids.length) await owner.query('delete from tenants where id = any($1::uuid[])', [ids]);
      await db.close();
      await owner.end();
    },
  };
}

export function connect(
  t: TestTenant,
  kind: SourceKind,
  config: Record<string, unknown>,
  status: 'connected' | 'partial' = 'connected',
) {
  return upsertConnection(t.handle, { userId: t.userId, kind, config, status });
}
