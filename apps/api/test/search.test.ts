import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertApplication, upsertCompany, upsertJob } from '@wma/db';
import { searchRoutes } from '../src/routes/search';
import { appFor, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
const slug = `searchtest-${Date.now()}`;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
  const { default: pg } = await import('pg');
  const owner = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test',
  });
  await owner.query('delete from companies where board_slug like $1', [`${slug}%`]);
  await owner.end();
});

const app = (t: TestTenant) => appFor(t, { '/search': searchRoutes });

async function seed(t: TestTenant, company: string, title = 'Engineer') {
  const co = await upsertCompany(t.handle, {
    name: company,
    ats: 'greenhouse',
    boardSlug: `${slug}-${randomUUID()}`,
    createdBy: 'llm',
  });
  const { job } = await upsertJob(t.handle, {
    companyId: co.id,
    ats: 'greenhouse',
    atsJobId: randomUUID(),
    title,
    url: `https://boards.greenhouse.io/${randomUUID()}`,
  });
  return (await insertApplication(t.handle, { userId: t.userId, jobId: job.id })).application;
}

describe('GET /search/companies', () => {
  it('matches "acm" to Acme Robotics case-insensitively with title and stage', async () => {
    const t = await env.makeTenant();
    const a = await seed(t, 'Acme Robotics', 'Staff Engineer');
    await seed(t, 'Globex');
    for (const q of ['acm', 'ACM', 'robo']) {
      const res = await app(t).request(`/search/companies?q=${q}`);
      expect(res.status).toBe(200);
      expect((await res.json()).results).toEqual([
        {
          application_id: a.id,
          company: 'Acme Robotics',
          title: 'Staff Engineer',
          status: 'pending',
          column: 'applied',
          badge: 'pending',
        },
      ]);
    }
  });

  it('returns an empty list for no match and never another tenant’s company', async () => {
    const t = await env.makeTenant();
    const other = await env.makeTenant();
    await seed(other, 'Globex Corporation');
    await seed(t, 'Acme Robotics');
    expect((await (await app(t).request('/search/companies?q=globex')).json()).results).toEqual([]);
    expect(
      (await (await app(other).request('/search/companies?q=globex')).json()).results,
    ).toHaveLength(1);
  });

  it('treats % and _ literally and caps results at 20', async () => {
    const t = await env.makeTenant();
    await seed(t, 'Percent 100% Inc');
    await seed(t, 'Plain Co');
    expect(
      (await (await app(t).request('/search/companies?q=100%25')).json()).results,
    ).toHaveLength(1);
    for (let i = 0; i < 22; i++) await seed(t, `Many ${i}`);
    expect((await (await app(t).request('/search/companies?q=many')).json()).results).toHaveLength(
      20,
    );
  });

  it('rejects a missing or one-character query with 400', async () => {
    const t = await env.makeTenant();
    expect((await app(t).request('/search/companies?q=a')).status).toBe(400);
    expect((await app(t).request('/search/companies?q=%20a%20')).status).toBe(400);
    expect((await app(t).request('/search/companies')).status).toBe(400);
  });
});
