import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  insertApplication,
  listStageOverrides,
  updateApplication,
  upsertCompany,
  upsertJob,
  getApplication,
  insertCaptchaRequest,
  insertInterview,
  insertInterviewSlot,
  updateCaptchaRequest,
  upsertEmailThread,
  schema,
  type ApplicationStatus,
} from '@wma/db';
import { applicationsRoutes } from '../src/routes/applications';
import { boardRoutes } from '../src/routes/board';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
const slug = `boardtest-${Date.now()}`;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
  const { default: pg } = await import('pg');
  const owner = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test',
  });
  await owner.query('delete from companies where board_slug = $1', [slug]);
  await owner.end();
});

const app = (t: TestTenant) =>
  appFor(t, { '/board': boardRoutes, '/applications': applicationsRoutes });

async function seed(
  t: TestTenant,
  company: string,
  status: ApplicationStatus,
  job: Partial<{ payMin: number; payMax: number; currency: string; locationMode: string }> = {},
) {
  const co = await upsertCompany(t.handle, {
    name: company,
    ats: 'greenhouse',
    boardSlug: `${slug}-${randomUUID()}`,
    createdBy: 'llm',
  });
  const { job: j } = await upsertJob(t.handle, {
    companyId: co.id,
    ats: 'greenhouse',
    atsJobId: randomUUID(),
    title: `${company} Engineer`,
    url: `https://boards.greenhouse.io/${randomUUID()}`,
    ...job,
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: j.id });
  await updateApplication(t.handle, application.id, {
    status,
    appliedAt: status === 'pending' ? null : new Date('2026-11-02T09:00:00Z'),
  });
  return application;
}

describe('GET /board', () => {
  it('maps five statuses to four columns with the pending one flagged inside Applied', async () => {
    const t = await env.makeTenant();
    const other = await env.makeTenant();
    const p = await seed(t, 'Pendco', 'pending');
    const a = await seed(t, 'Appco', 'applied', {
      payMin: 150000,
      payMax: 190000,
      currency: 'USD',
      locationMode: 'remote',
    });
    const i = await seed(t, 'Intco', 'interviewing');
    const o = await seed(t, 'Offco', 'offer');
    const x = await seed(t, 'Closeco', 'closed');
    await seed(other, 'Foreign', 'applied');

    const res = await app(t).request('/board');
    expect(res.status).toBe(200);
    const { columns } = await res.json();
    expect(Object.keys(columns)).toEqual(['applied', 'interviewing', 'offer', 'closed']);
    const ids = (k: string) => columns[k].map((c: { id: string }) => c.id).sort();
    expect(ids('applied')).toEqual([p.id, a.id].sort());
    expect(ids('interviewing')).toEqual([i.id]);
    expect(ids('offer')).toEqual([o.id]);
    expect(ids('closed')).toEqual([x.id]);
    const pending = columns.applied.find((c: { id: string }) => c.id === p.id);
    expect(pending).toMatchObject({ badge: 'pending', status: 'pending', company: 'Pendco' });
    const applied = columns.applied.find((c: { id: string }) => c.id === a.id);
    expect(applied).toMatchObject({
      badge: null,
      company: 'Appco',
      title: 'Appco Engineer',
      location_mode: 'remote',
      pay_min: 150000,
      pay_max: 190000,
      currency: 'USD',
      applied_at: '2026-11-02T09:00:00.000Z',
    });
    expect(applied.last_activity_at).toMatch(/^\d{4}-/);
    // Another tenant's card never appears.
    expect(JSON.stringify(columns)).not.toContain('Foreign');
  });

  it('renders four empty columns for a user with nothing', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/board');
    expect(await res.json()).toEqual({
      columns: { applied: [], interviewing: [], offer: [], closed: [] },
    });
  });
});

describe('POST /applications/:id/stage', () => {
  it('a move into Offer records the pay-data job with the move; other moves record none', async () => {
    const t = await env.makeTenant();
    const a = await seed(t, 'Offerco', 'interviewing');
    const rows = () =>
      t.handle.run((tx) =>
        tx.select().from(schema.pendingJobs).where(eq(schema.pendingJobs.tenantId, t.id)),
      );
    await app(t).request(
      `/applications/${a.id}/stage`,
      json({ from: 'interviewing', to: 'closed' }),
    );
    await app(t).request(
      `/applications/${a.id}/stage`,
      json({ from: 'closed', to: 'interviewing' }),
    );
    expect(await rows()).toEqual([]);
    const res = await app(t).request(
      `/applications/${a.id}/stage`,
      json({ from: 'interviewing', to: 'offer' }),
    );
    expect(res.status).toBe(200);
    const recorded = await rows();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: 'negotiation',
      dedupeKey: `negotiation:${a.id}`,
      dispatchedAt: null,
      payload: { tenantId: t.id, userId: t.userId, applicationId: a.id },
    });
    // a stale move writes nothing, not even the job
    const stale = await app(t).request(
      `/applications/${a.id}/stage`,
      json({ from: 'interviewing', to: 'offer' }),
    );
    expect(stale.status).toBe(409);
    expect(await rows()).toHaveLength(1);
  });

  it('moves Applied to Closed and writes status, override and a user activity entry', async () => {
    const t = await env.makeTenant();
    const a = await seed(t, 'Moveco', 'applied');
    const res = await app(t).request(
      `/applications/${a.id}/stage`,
      json({ from: 'applied', to: 'closed' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: a.id, status: 'closed' });
    const row = await getApplication(t.handle, a.id);
    expect(row).toMatchObject({ status: 'closed', closedReason: 'user' });
    const overrides = await listStageOverrides(t.handle, a.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ fromStatus: 'applied', toStatus: 'closed' });
    const log = await activity.listByApplication(t.handle, a.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      actor: 'user',
      action: 'stage_changed',
      detail: { from: 'applied', to: 'closed' },
    });
    const board = await (await app(t).request('/board')).json();
    expect(board.columns.closed.map((c: { id: string }) => c.id)).toEqual([a.id]);
  });

  it('answers 409 with the current status and writes nothing when the client was stale', async () => {
    const t = await env.makeTenant();
    const a = await seed(t, 'Staleco', 'interviewing');
    const res = await app(t).request(
      `/applications/${a.id}/stage`,
      json({ from: 'applied', to: 'closed' }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'stage_conflict', current: 'interviewing' });
    expect((await getApplication(t.handle, a.id))?.status).toBe('interviewing');
    expect(await listStageOverrides(t.handle, a.id)).toHaveLength(0);
    expect(await activity.listByApplication(t.handle, a.id)).toHaveLength(0);
  });

  it('is 404 for another user’s card or a malformed id, 400 for a bad body', async () => {
    const t = await env.makeTenant();
    const other = await env.makeTenant();
    const theirs = await seed(other, 'Theirs', 'applied');
    const body = json({ from: 'applied', to: 'closed' });
    expect((await app(t).request(`/applications/${theirs.id}/stage`, body)).status).toBe(404);
    expect((await app(t).request('/applications/nope/stage', body)).status).toBe(404);
    expect((await getApplication(other.handle, theirs.id))?.status).toBe('applied');
    const mine = await seed(t, 'Mine', 'applied');
    expect(
      (await app(t).request(`/applications/${mine.id}/stage`, json({ from: 'applied', to: 'x' })))
        .status,
    ).toBe(400);
    expect(
      (
        await app(t).request(
          `/applications/${mine.id}/stage`,
          json({ from: 'applied', to: 'pending' }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('GET /board attention', () => {
  const attentionOf = async (t: TestTenant, id: string) => {
    const { columns } = await (await app(t).request('/board')).json();
    const all = Object.values(columns).flat() as Array<{ id: string; attention: unknown }>;
    return all.find((c) => c.id === id)!.attention;
  };

  it('flags an open human CAPTCHA and clears it once resolved', async () => {
    const t = await env.makeTenant();
    const a = await seed(t, 'Capco', 'pending');
    expect(await attentionOf(t, a.id)).toBeNull();
    const req = await insertCaptchaRequest(t.handle, {
      userId: t.userId,
      applicationId: a.id,
      stage: 'human',
    });
    expect(await attentionOf(t, a.id)).toEqual({ kind: 'captcha', label: 'Solve a CAPTCHA' });
    await updateCaptchaRequest(t.handle, req.id, { resolvedAt: new Date(), resolvedBy: 'human' });
    expect(await attentionOf(t, a.id)).toBeNull();
  });

  it('flags an interview with open slot links and not one that is confirmed or expired', async () => {
    const t = await env.makeTenant();
    const a = await seed(t, 'Slotco', 'interviewing');
    const thread = await upsertEmailThread(t.handle, {
      userId: t.userId,
      gmailThreadId: `g-${randomUUID()}`,
      kind: 'interview',
      applicationId: a.id,
    });
    const { interview } = await insertInterview(t.handle, {
      userId: t.userId,
      applicationId: a.id,
      threadId: thread.id,
    });
    const startsAt = new Date('2026-12-01T17:00:00Z');
    const endsAt = new Date('2026-12-01T17:30:00Z');
    await insertInterviewSlot(t.handle, {
      interviewId: interview.id,
      startsAt,
      endsAt,
      tokenHash: randomUUID(),
      ttlSeconds: -60,
    });
    expect(await attentionOf(t, a.id)).toBeNull();
    await insertInterviewSlot(t.handle, {
      interviewId: interview.id,
      startsAt,
      endsAt,
      tokenHash: randomUUID(),
    });
    expect(await attentionOf(t, a.id)).toEqual({
      kind: 'pick_time',
      label: 'Pick an interview time',
    });
  });

  it('flags a pending application on an unsupported ATS and never a closed one', async () => {
    const t = await env.makeTenant();
    const a = await seed(t, 'Handco', 'pending');
    await updateApplication(t.handle, a.id, { pendingReason: 'unsupported-ats' });
    expect(await attentionOf(t, a.id)).toEqual({ kind: 'apply_by_hand', label: 'Apply by hand' });
    await updateApplication(t.handle, a.id, { status: 'closed', closedReason: 'withdrawn' });
    expect(await attentionOf(t, a.id)).toBeNull();
  });
});
