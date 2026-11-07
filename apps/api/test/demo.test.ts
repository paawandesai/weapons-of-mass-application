import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createUser } from '@wma/db';
import { checkDemoTenants } from '../src/demo-check';
import { cookieHeader, cookiesFrom, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
let tenantId: string;
let userId: string;
let otherTenantId: string;
const TOKEN = 'demo-secret-token';
const prevNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
  env = await setupEnv();
  tenantId = await env.db.createTenant();
  const tag = randomUUID();
  const user = await createUser(env.db.forTenant(tenantId), {
    email: `auth-demo-${tag}@example.test`,
    googleSub: `auth-sub-${tag}`,
  });
  userId = user.id;
  otherTenantId = await env.db.createTenant();
});
afterEach(async () => {
  delete process.env.DEMO_LOGIN_TOKEN;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  await env.owner.query('update tenants set demo = false where id = any($1::uuid[])', [
    [tenantId, otherTenantId],
  ]);
});
afterAll(async () => {
  await env.owner.query('delete from tenants where id = any($1::uuid[])', [
    [tenantId, otherTenantId],
  ]);
  await env.cleanup();
});

const flag = (...ids: string[]) =>
  env.owner.query('update tenants set demo = true where id = any($1::uuid[])', [ids]);
const post = (headers: Record<string, string> = {}, body?: unknown) =>
  env.app.request('/auth/demo', {
    method: 'POST',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe('POST /auth/demo', () => {
  it('is 404 when DEMO_LOGIN_TOKEN is not set, even with a flagged demo user', async () => {
    await flag(tenantId);
    expect((await post({ 'x-demo-token': TOKEN })).status).toBe(404);
  });

  it('is 404 in production, with the right token', async () => {
    await flag(tenantId);
    process.env.DEMO_LOGIN_TOKEN = TOKEN;
    process.env.NODE_ENV = 'production';
    expect((await post({ 'x-demo-token': TOKEN })).status).toBe(404);
  });

  it('is 404 without the token or with a wrong one', async () => {
    await flag(tenantId);
    process.env.DEMO_LOGIN_TOKEN = TOKEN;
    expect((await post()).status).toBe(404);
    expect((await post({ 'x-demo-token': 'wrong' })).status).toBe(404);
    expect((await post({}, { token: 'wrong' })).status).toBe(404);
  });

  it('is 404 when no tenant is flagged or two are', async () => {
    process.env.DEMO_LOGIN_TOKEN = TOKEN;
    expect((await post({ 'x-demo-token': TOKEN })).status).toBe(404);
    await flag(tenantId, otherTenantId);
    expect((await post({ 'x-demo-token': TOKEN })).status).toBe(404);
  });

  it('with the token creates a session for the demo user', async () => {
    await flag(tenantId);
    process.env.DEMO_LOGIN_TOKEN = TOKEN;
    const res = await post({ 'x-demo-token': TOKEN });
    expect(res.status).toBe(200);
    const jar = cookiesFrom(res);
    expect(jar.wma_session).toBeTruthy();
    const row = await env.owner.query('select tenant_id, user_id from sessions where id = $1', [
      jar.wma_session,
    ]);
    expect(row.rows[0]).toEqual({ tenant_id: tenantId, user_id: userId });
    const me = await env.app.request('/api/me', { headers: { cookie: cookieHeader(jar) } });
    expect(me.status).toBe(200);
    // The body token form works too.
    expect((await post({}, { token: TOKEN })).status).toBe(200);
  });
});

describe('placeholder routes', () => {
  it('are mounted behind the session', async () => {
    for (const path of ['/api/board', '/api/search', '/api/interviews']) {
      expect((await env.app.request(path)).status).toBe(401);
    }
  });
});

describe('demo flag startup check', () => {
  it('logs an error with two flagged tenants and not with one', async () => {
    const log = vi.fn();
    await flag(tenantId);
    expect(await checkDemoTenants(env.db, log)).toBe(1);
    expect(log).not.toHaveBeenCalled();
    await flag(tenantId, otherTenantId);
    expect(await checkDemoTenants(env.db, log)).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/2 tenants have demo = true/);
  });

  it('does not throw when the check itself fails', async () => {
    const log = vi.fn();
    const broken = { demoTenantCount: () => Promise.reject(new Error('db down')) };
    expect(await checkDemoTenants(broken, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
