import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertDemoMessage } from '@wma/db';
import {
  bodyParts,
  createAdminRoutes,
  type SyncNowData,
  type SyncQueue,
} from '../src/routes/admin';
import { appFor, setupEnv, type TestEnv, type TestTenant } from './support';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
let env: TestEnv;
let owner: pg.Pool;
let demo: TestTenant;
let real: TestTenant;

beforeAll(async () => {
  env = await setupEnv();
  owner = new pg.Pool({ connectionString: ownerUrl });
  demo = await env.makeTenant();
  real = await env.makeTenant();
  await owner.query('update tenants set demo = true where id = $1', [demo.id]);
});
afterAll(async () => {
  await owner.query('update tenants set demo = false where id = $1', [demo.id]);
  await owner.end();
  await env.cleanup();
});

function setup(t: TestTenant) {
  const queued: SyncNowData[] = [];
  const queue: SyncQueue = { enqueueSyncNow: async (d) => void queued.push(d) };
  return { queued, app: appFor(t, { '/admin': createAdminRoutes({ queue }) }) };
}

describe('POST /api/admin/sync-now', () => {
  it('queues the sync for a demo tenant', async () => {
    const { app, queued } = setup(demo);
    const res = await app.request('/admin/sync-now', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(queued).toEqual([{ tenantId: demo.id, userId: demo.userId }]);
  });

  it('is 404 for a tenant without the demo flag and queues nothing', async () => {
    const { app, queued } = setup(real);
    const res = await app.request('/admin/sync-now', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(queued).toEqual([]);
  });
});

describe('GET /api/admin/demo-mailbox', () => {
  it("lists the demo user's mail newest first, with links split out of the body", async () => {
    await insertDemoMessage(demo.handle, {
      userId: demo.userId,
      gmailMessageId: 'm-old',
      fromAddress: 'priya@acme.example',
      fromName: 'Priya N',
      toAddress: demo.email,
      subject: 'Interview times',
      bodyText: 'Pick one at https://app.test/confirm/abc. Thanks',
      internalDate: new Date('2026-11-01T10:00:00Z'),
    });
    await insertDemoMessage(demo.handle, {
      userId: demo.userId,
      gmailMessageId: 'm-sent',
      fromAddress: demo.email,
      toAddress: 'priya@acme.example',
      subject: 'Re: Interview times',
      bodyText: 'Thursday works.',
      labelIds: ['SENT'],
    });
    const { app } = setup(demo);
    const res = await app.request('/admin/demo-mailbox');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.map((m) => m.id)).toEqual(['m-sent', 'm-old']);
    expect(body.messages[0]).toMatchObject({ direction: 'sent', subject: 'Re: Interview times' });
    expect(body.messages[1]).toMatchObject({
      direction: 'received',
      from: 'Priya N <priya@acme.example>',
      body_text: 'Pick one at https://app.test/confirm/abc. Thanks',
      body: [
        { type: 'text', value: 'Pick one at ' },
        { type: 'link', value: 'https://app.test/confirm/abc' },
        { type: 'text', value: '. Thanks' },
      ],
    });
  });

  it('is 404 for a tenant without the demo flag and shows nothing of another tenant', async () => {
    const res = await setup(real).app.request('/admin/demo-mailbox');
    expect(res.status).toBe(404);
  });

  it('turns only http(s) urls into links', () => {
    expect(bodyParts('see javascript:alert(1) and http://a.test/x?y=1, ok')).toEqual([
      { type: 'text', value: 'see javascript:alert(1) and ' },
      { type: 'link', value: 'http://a.test/x?y=1' },
      { type: 'text', value: ', ok' },
    ]);
  });
});

describe('the demo flag has no write path', () => {
  it('refuses every attempt with 403 and leaves the value unchanged', async () => {
    for (const t of [real, demo]) {
      const { app } = setup(t);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await app.request('/admin/demo-flag', {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'DELETE' ? {} : { body: JSON.stringify({ demo: true }) }),
        });
        expect(res.status).toBe(403);
      }
    }
    const rows = await owner.query<{ id: string; demo: boolean }>(
      'select id, demo from tenants where id = any($1::uuid[])',
      [[demo.id, real.id]],
    );
    const flag = (id: string) => rows.rows.find((r) => r.id === id)?.demo;
    expect(flag(real.id)).toBe(false);
    expect(flag(demo.id)).toBe(true);
  });
});
