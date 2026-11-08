import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOutreachDraft,
  getOutreachDraft,
  insertApplication,
  insertProfileVersion,
  listUndispatchedJobs,
  setApprovedProfileVersion,
  upsertCompany,
  upsertJob,
  outreachContentHash,
} from '@wma/db';
import fixture from '../../../packages/shared/test/fixtures/profile.full.json';
import { outreachRoutes } from '../src/routes/outreach';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
const slug = `outreachtest-${Date.now()}`;
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

const app = (t: TestTenant) => appFor(t, { '/outreach': outreachRoutes });

async function setup(opts: { approved?: boolean } = {}) {
  const t = await env.makeTenant();
  if (opts.approved !== false) {
    const row = await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: fixture as never,
    });
    await setApprovedProfileVersion(t.handle, t.userId, row.version);
  }
  const co = await upsertCompany(t.handle, {
    name: 'Acme',
    ats: 'greenhouse',
    boardSlug: `${slug}-${randomUUID()}`,
    createdBy: 'llm',
  });
  const { job } = await upsertJob(t.handle, {
    companyId: co.id,
    ats: 'greenhouse',
    atsJobId: randomUUID(),
    title: 'Backend Engineer',
    url: `https://boards.greenhouse.io/${randomUUID()}`,
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
  const draft = () =>
    createOutreachDraft(t.handle, {
      userId: t.userId,
      applicationId: application.id,
      contactName: 'Riley Park',
      toAddress: 'riley.park@example.com',
      subject: 'Backend Engineer',
      bodyText: 'Hi Riley, I would like to talk about the role.',
    });
  return { t, application, draft };
}

const contact = {
  name: 'Riley Park',
  title: 'Recruiter',
  profile_url: null,
  email: 'Riley.Park@Example.com',
};

describe('POST /outreach/drafts', () => {
  it('queues a draft job for the worker and sends nothing', async () => {
    const { t, application } = await setup();
    const res = await app(t).request(
      '/outreach/drafts',
      json({ application_id: application.id, contact }),
    );
    expect(res.status).toBe(202);
    const jobs = await listUndispatchedJobs(t.handle);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('draft-outreach');
    expect(jobs[0]!.payload).toMatchObject({
      applicationId: application.id,
      contact: { email: 'riley.park@example.com', name: 'Riley Park' },
    });
  });

  it('needs an approved profile', async () => {
    const { t, application } = await setup({ approved: false });
    const res = await app(t).request(
      '/outreach/drafts',
      json({ application_id: application.id, contact }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('profile_not_approved');
  });

  it("404s for someone else's application", async () => {
    const a = await setup();
    const b = await setup();
    const res = await app(b.t).request(
      '/outreach/drafts',
      json({ application_id: a.application.id, contact }),
    );
    expect(res.status).toBe(404);
  });

  it('rejects a bad email and a non-http profile link', async () => {
    const { t, application } = await setup();
    const bad = await app(t).request(
      '/outreach/drafts',
      json({ application_id: application.id, contact: { ...contact, email: 'nope' } }),
    );
    expect(bad.status).toBe(400);
    const js = await app(t).request(
      '/outreach/drafts',
      json({
        application_id: application.id,
        contact: { ...contact, profile_url: 'javascript:alert(1)' },
      }),
    );
    expect(js.status).toBe(400);
  });
});

describe('approve / edit / reject', () => {
  it('approving queues the send job; nothing is sent by the API', async () => {
    const { t, draft } = await setup();
    const d = await draft();
    const list = await (await app(t).request('/outreach')).json();
    const hash = list.drafts[0].content_hash;
    expect(hash).toBe(outreachContentHash(d));
    const res = await app(t).request(`/outreach/${d.id}/approve`, json({ content_hash: hash }));
    expect(res.status).toBe(200);
    expect((await res.json()).draft.state).toBe('approved');
    const jobs = await listUndispatchedJobs(t.handle);
    expect(jobs.map((j) => j.kind)).toEqual(['send-outreach']);
    expect(jobs[0]!.payload).toMatchObject({ draftId: d.id, userId: t.userId });
  });

  it('refuses a stale hash after an edit, and the edit clears an earlier approval', async () => {
    const { t, draft } = await setup();
    const d = await draft();
    const hash = outreachContentHash(d);
    const edit = await app(t).request(
      `/outreach/${d.id}`,
      json({ body_text: 'A better note.' }, 'PATCH'),
    );
    expect(edit.status).toBe(200);
    const stale = await app(t).request(`/outreach/${d.id}/approve`, json({ content_hash: hash }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('stale');
    expect(await listUndispatchedJobs(t.handle)).toHaveLength(0);

    const fresh = (await edit.json()).draft.content_hash;
    await app(t).request(`/outreach/${d.id}/approve`, json({ content_hash: fresh }));
    const again = await app(t).request(
      `/outreach/${d.id}`,
      json({ subject: 'Changed after approval' }, 'PATCH'),
    );
    expect((await again.json()).draft.state).toBe('draft');
    expect((await getOutreachDraft(t.handle, t.userId, d.id))!.approvedHash).toBeNull();
  });

  it('cannot approve twice, or approve a rejected draft', async () => {
    const { t, draft } = await setup();
    const d = await draft();
    const hash = outreachContentHash(d);
    expect(
      (await app(t).request(`/outreach/${d.id}/approve`, json({ content_hash: hash }))).status,
    ).toBe(200);
    const twice = await app(t).request(`/outreach/${d.id}/approve`, json({ content_hash: hash }));
    expect(twice.status).toBe(409);
    expect((await twice.json()).code).toBe('wrong_state');
    expect(await listUndispatchedJobs(t.handle)).toHaveLength(1);

    const other = await draft();
    await app(t).request(`/outreach/${other.id}/reject`, json({}));
    const r = await app(t).request(
      `/outreach/${other.id}/approve`,
      json({ content_hash: outreachContentHash(other) }),
    );
    expect(r.status).toBe(409);
  });

  it("cannot touch another user's draft", async () => {
    const a = await setup();
    const b = await setup();
    const d = await a.draft();
    const hash = outreachContentHash(d);
    expect(
      (await app(b.t).request(`/outreach/${d.id}/approve`, json({ content_hash: hash }))).status,
    ).toBe(404);
    expect(
      (await app(b.t).request(`/outreach/${d.id}`, json({ subject: 'x' }, 'PATCH'))).status,
    ).toBe(409);
    expect((await app(b.t).request(`/outreach/${d.id}/reject`, json({}))).status).toBe(409);
    expect((await getOutreachDraft(a.t.handle, a.t.userId, d.id))!.state).toBe('draft');
  });

  it('refuses approval once the daily cap of sent emails is reached', async () => {
    const { t, draft } = await setup();
    const { default: pg } = await import('pg');
    const owner = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test',
    });
    for (let i = 0; i < 5; i++) {
      const d = await draft();
      await owner.query(
        "update outreach_drafts set state = 'sent', sent_at = now() where id = $1",
        [d.id],
      );
    }
    await owner.end();
    const fresh = await draft();
    const res = await app(t).request(
      `/outreach/${fresh.id}/approve`,
      json({ content_hash: outreachContentHash(fresh) }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('daily_cap');
    expect(await listUndispatchedJobs(t.handle)).toHaveLength(0);
  });
});

describe('GET /outreach', () => {
  it("lists only the caller's drafts and reports the cap", async () => {
    const a = await setup();
    const b = await setup();
    await a.draft();
    const res = await (await app(b.t).request('/outreach')).json();
    expect(res.drafts).toHaveLength(0);
    expect(res.daily_cap).toBe(5);
    expect((await (await app(a.t).request('/outreach')).json()).drafts).toHaveLength(1);
  });
});
