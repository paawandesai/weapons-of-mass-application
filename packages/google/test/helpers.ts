import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDb, createUser, loadEnv, schema, vault, type Db, type TenantHandle } from '@wma/db';

loadEnv();
process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
const appUrl = (() => {
  const u = new URL(ownerUrl);
  u.username = 'wma_app';
  u.password = process.env.APP_DB_PASSWORD || 'wma_app';
  return u.toString();
})();

export interface Fixture {
  db: Db;
  owner: pg.Pool;
  tenantId: string;
  userId: string;
  handle: TenantHandle;
  cleanup(): Promise<void>;
}

export async function setupFixture(refreshToken = 'refresh-token-1'): Promise<Fixture> {
  const owner = new pg.Pool({ connectionString: ownerUrl });
  const db = createDb(appUrl);
  const tenantId = await db.createTenant();
  const handle = db.forTenant(tenantId);
  const tag = randomUUID();
  const user = await createUser(handle, { email: `${tag}@example.test`, googleSub: `sub-${tag}` });
  await handle.run((tx) =>
    tx.insert(schema.sourceConnections).values(
      (['gmail', 'calendar', 'drive'] as const).map((kind) => ({
        tenantId,
        userId: user.id,
        kind,
        status: 'connected' as const,
      })),
    ),
  );
  await vault.put(handle, user.id, 'google_refresh_token', 'google', refreshToken);
  return {
    db,
    owner,
    tenantId,
    userId: user.id,
    handle,
    async cleanup() {
      await owner.query('delete from tenants where id = $1', [tenantId]);
      await db.close();
      await owner.end();
    },
  };
}
