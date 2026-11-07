import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { activity, listUserCompanies, upsertCompany, upsertUserCompany } from '@wma/db';
import { createHttp, resolveBoard } from '@wma/discovery';
import { createCompaniesRoutes } from '../src/routes/companies';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
const hits: string[] = [];
const board =
  (kind: string, boards: Record<string, unknown>) =>
  ({ params }: { params: Record<string, unknown> }) => {
    const slug = String(params.slug);
    hits.push(`${kind}:${slug}`);
    return slug in boards
      ? HttpResponse.json(boards[slug] as never)
      : new HttpResponse('{}', { status: 404 });
  };
const server = setupServer(
  http.get(
    'https://boards-api.greenhouse.io/v1/boards/:slug/jobs',
    board('greenhouse', { 'cedar-grove': { jobs: [] } }),
  ),
  http.get('https://api.lever.co/v0/postings/:slug', board('lever', { 'cedar-grove': [] })),
  http.get('https://api.ashbyhq.com/posting-api/job-board/:slug', board('ashby', {})),
);
beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  env = await setupEnv();
});
afterEach(() => {
  hits.length = 0;
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await env.cleanup();
});

const resolver = (timeoutMs = 2000) => {
  const client = createHttp({ sleep: async () => {}, timeoutMs, backoffMs: 0 });
  return (name: string) => resolveBoard(name, [], { http: client });
};
const app = (t: TestTenant, timeoutMs?: number) =>
  appFor(t, { '/companies': createCompaniesRoutes({ resolve: resolver(timeoutMs) }) });
// Unique per run: the board cache is global and shared with other tests.
const uniq = Math.random().toString(36).slice(2, 8);

describe('POST /companies', () => {
  it('add by board URL: ATS and slug parsed from the URL, no network call, user action logged', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request(
      '/companies',
      json({ board_url: `https://jobs.ashbyhq.com/Fable-${uniq}` }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.companies).toHaveLength(1);
    expect(body.companies[0]).toMatchObject({
      name: `Fable ${uniq[0]!.toUpperCase()}${uniq.slice(1)}`,
      ats: 'ashby',
      board_slug: `fable-${uniq}`,
      board_url: `https://jobs.ashbyhq.com/fable-${uniq}`,
      resolved: true,
      source: 'user',
    });
    expect(hits).toEqual([]);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log[0]).toMatchObject({
      actor: 'user',
      action: 'company_added',
      detail: { via: 'url', ats: 'ashby' },
    });
    expect((await listUserCompanies(t.handle, t.userId)).map((r) => r.membership.source)).toEqual([
      'user',
    ]);
  });

  it('add by an EU Lever board URL keeps the region in the stored URL; the US board of the same slug is a different company', async () => {
    const t = await env.makeTenant();
    const slug = `euco-${uniq}`;
    const eu = await (
      await app(t).request('/companies', json({ board_url: `https://jobs.eu.lever.co/${slug}` }))
    ).json();
    expect(eu.companies[0]).toMatchObject({
      ats: 'lever',
      board_slug: slug,
      board_url: `https://jobs.eu.lever.co/${slug}`,
    });
    const us = await (
      await app(t).request('/companies', json({ board_url: `https://jobs.lever.co/${slug}` }))
    ).json();
    expect(us.companies[0].board_url).toBe(`https://jobs.lever.co/${slug}`);
    expect(us.companies[0].id).not.toBe(eu.companies[0].id);
    expect(hits).toEqual([]);
  });

  it('add by name: resolved against the ATS APIs and stored', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/companies', json({ name: 'Cedar Grove' }));
    expect(res.status).toBe(201);
    const { companies } = await res.json();
    expect(companies.map((c: { ats: string }) => c.ats).sort()).toEqual(['greenhouse', 'lever']);
    expect(companies.every((c: { board_slug: string }) => c.board_slug === 'cedar-grove')).toBe(
      true,
    );
  });

  it('a second user adding the same name reuses the cached board with no lookup', async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    await app(a).request('/companies', json({ name: 'Cedar Grove' }));
    hits.length = 0;
    const res = await app(b).request('/companies', json({ name: 'cedar grove' }));
    expect(res.status).toBe(201);
    expect(hits).toEqual([]);
    expect((await res.json()).companies).toHaveLength(2);
  });

  it('add a company that resolves nowhere: 400 naming the three supported ATSs, nothing stored', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/companies', json({ name: 'Nonesuch Industries' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('unresolvable_company');
    for (const ats of ['Ashby', 'Greenhouse', 'Lever']) expect(body.message).toContain(ats);
    expect(await listUserCompanies(t.handle, t.userId, { includeRemoved: true })).toEqual([]);
  });

  it('an ATS outage is a 503 (retry later), not a claim that the company has no board', async () => {
    server.use(
      http.get('https://api.lever.co/v0/postings/:slug', async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      }),
    );
    const t = await env.makeTenant();
    const res = await app(t, 50).request('/companies', json({ name: 'Nonesuch Industries' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('resolution_unavailable');
  });

  it('rejects a URL that is not a supported board, and a body with neither or both fields', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    const bad = await a.request('/companies', json({ board_url: 'https://example.com/careers' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toMatch(/Ashby, Greenhouse or Lever/);
    expect((await a.request('/companies', json({}))).status).toBe(400);
    expect(
      (await a.request('/companies', json({ name: 'x', board_url: 'https://jobs.lever.co/x' })))
        .status,
    ).toBe(400);
    expect((await a.request('/companies', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('adding a company already on the list is a 200 and changes nothing', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    await a.request('/companies', json({ board_url: `https://jobs.lever.co/dup-${uniq}` }));
    const again = await a.request(
      '/companies',
      json({ board_url: `https://jobs.lever.co/dup-${uniq}` }),
    );
    expect(again.status).toBe(200);
    expect(await listUserCompanies(t.handle, t.userId)).toHaveLength(1);
  });
});

describe('DELETE /companies/:id and GET /companies', () => {
  it('removes a company: gone from the list, kept as a user override, logged as a user action', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    const added = await (
      await a.request('/companies', json({ board_url: `https://jobs.lever.co/rm-${uniq}` }))
    ).json();
    const id = added.companies[0].id;
    const res = await a.request(`/companies/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await (await a.request('/companies')).json()).companies).toEqual([]);
    const rows = await listUserCompanies(t.handle, t.userId, { includeRemoved: true });
    expect(rows[0]!.membership.removedAt).not.toBeNull();
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log[0]).toMatchObject({
      actor: 'user',
      action: 'company_removed',
      detail: { company_id: id },
    });
    // removing twice, or something never on the list, is a 404
    expect((await a.request(`/companies/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await a.request('/companies/not-a-uuid', { method: 'DELETE' })).status).toBe(404);
    // 36 characters from the UUID alphabet that are not a UUID: 404, not a Postgres error
    for (const bad of [
      'a'.repeat(36),
      '-'.repeat(36),
      `${'0'.repeat(13)}-0000-0000-0000-00000000000`,
    ]) {
      expect((await a.request(`/companies/${bad}`, { method: 'DELETE' })).status).toBe(404);
    }
  });

  it('re-adding a removed company restores it', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    const url = `https://jobs.lever.co/back-${uniq}`;
    const id = (await (await a.request('/companies', json({ board_url: url }))).json()).companies[0]
      .id;
    await a.request(`/companies/${id}`, { method: 'DELETE' });
    const res = await a.request('/companies', json({ board_url: url }));
    expect(res.status).toBe(201);
    expect((await (await a.request('/companies')).json()).companies).toHaveLength(1);
  });

  it("lists the user's companies including ones dropped as unresolved, and never another user's", async () => {
    const t = await env.makeTenant();
    const other = await env.makeTenant();
    const dropped = await upsertCompany(t.handle, { name: `Ghostco ${uniq}`, createdBy: 'llm' });
    await upsertUserCompany(t.handle, {
      userId: t.userId,
      companyId: dropped.id,
      source: 'llm',
      reason: 'Looked relevant.',
    });
    const ok = await upsertCompany(t.handle, {
      name: 'Cedar Grove',
      ats: 'lever',
      boardSlug: 'cedar-grove',
      createdBy: 'llm',
    });
    await upsertUserCompany(t.handle, {
      userId: t.userId,
      companyId: ok.id,
      source: 'llm',
      reason: 'Good fit.',
    });
    await upsertUserCompany(other.handle, {
      userId: other.userId,
      companyId: ok.id,
      source: 'llm',
    });
    const body = await (await app(t).request('/companies')).json();
    expect(
      body.companies.map((c: { name: string; resolved: boolean; reason: string }) => [
        c.name,
        c.resolved,
        c.reason,
      ]),
    ).toEqual([
      [`Ghostco ${uniq}`, false, 'Looked relevant.'],
      ['Cedar Grove', true, 'Good fit.'],
    ]);
    // another user cannot remove my company
    const res = await app(other).request(`/companies/${dropped.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
