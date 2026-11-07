import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';
import { createDb, createUser, loadEnv, type Db, type TenantHandle } from '@wma/db';
import type { AppEnv } from '../src/middleware/session';

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

/** A tiny app that mounts a sub-app behind a fake session middleware for one tenant user. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TestResponse extends Omit<Response, 'json'> {
  json(): Promise<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface TestApp extends Omit<Hono<AppEnv>, 'request'> {
  request(path: string, init?: RequestInit): Promise<TestResponse>;
}

export function appFor(t: TestTenant, mount: Record<string, Hono<AppEnv>>): TestApp {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('session', { sessionId: 'test', handle: t.handle, userId: t.userId, tenantId: t.id });
    await next();
  });
  for (const [path, sub] of Object.entries(mount)) app.route(path, sub);
  return app as unknown as TestApp;
}

export const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
