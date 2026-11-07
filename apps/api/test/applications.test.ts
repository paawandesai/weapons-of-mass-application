import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  incrementCaptchaAttempt,
  insertApplication,
  insertCaptchaRequest,
  updateApplication,
  updateCaptchaRequest,
  upsertCompany,
  upsertJob,
} from '@wma/db';
import { applicationsRoutes } from '../src/routes/applications';
import { appFor, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
let companyId: string;
const slug = `apitest-${Date.now()}`;
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

const app = (t: TestTenant) => appFor(t, { '/applications': applicationsRoutes });
let n = 0;

async function seed(t: TestTenant, title: string) {
  const company = await upsertCompany(t.handle, {
    name: 'Acme Robotics',
    ats: 'greenhouse',
    boardSlug: slug,
    createdBy: 'llm',
  });
  companyId = company.id;
  const { job } = await upsertJob(t.handle, {
    companyId,
    ats: 'greenhouse',
    atsJobId: String(++n + Date.now()),
    title,
    url: `https://boards.greenhouse.io/${slug}/jobs/${n + Date.now()}`,
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
  return { job, application };
}

describe('GET /applications', () => {
  it('lists the user’s applications and filters by status', async () => {
    const t = await env.makeTenant();
    const other = await env.makeTenant();
    const a = await seed(t, 'Backend Engineer');
    const b = await seed(t, 'Platform Engineer');
    await seed(other, 'Not yours');
    await updateApplication(t.handle, b.application.id, {
      status: 'applied',
      appliedAt: new Date(),
    });

    const all = await (await app(t).request('/applications')).json();
    expect(all.applications.map((x: { id: string }) => x.id).sort()).toEqual(
      [a.application.id, b.application.id].sort(),
    );
    expect(all.applications.find((x: { id: string }) => x.id === a.application.id)).toMatchObject({
      status: 'pending',
      pending_reason: null,
      attempt_count: 0,
      job: { title: 'Backend Engineer', company: 'Acme Robotics', ats: 'greenhouse' },
    });

    const pending = await (await app(t).request('/applications?status=pending')).json();
    expect(pending.applications.map((x: { id: string }) => x.id)).toEqual([a.application.id]);
    const both = await (await app(t).request('/applications?status=pending,applied')).json();
    expect(both.applications).toHaveLength(2);
    expect((await app(t).request('/applications?status=nope')).status).toBe(400);
  });
});

describe('GET /applications/:id', () => {
  it('returns the resume ref, answers, unmet requirements, activity and captcha summary', async () => {
    const t = await env.makeTenant();
    const { job, application } = await seed(t, 'Staff Engineer');
    await updateApplication(t.handle, application.id, {
      status: 'applied',
      appliedAt: new Date('2026-11-01T10:00:00Z'),
      confirmationSource: 'page',
      resumePdfRef: `tenants/${t.id}/applications/${application.id}/resume.pdf`,
      unmetRequirements: ['Rust', 'CKA certification'],
      formAnswers: {
        'Full name': 'Mara Quill',
        'Why do you want to work here?': 'Because the work is interesting.',
        'Optional note': null,
        Gender: { skipped: 'self-identification' },
        Resume: { attached: 'resume.pdf' },
      },
    });
    for (const action of ['submission-started', 'tailored', 'filled', 'submitted']) {
      await activity.logActivity(t.handle, {
        userId: t.userId,
        applicationId: application.id,
        actor: 'agent',
        action,
        detail: action === 'submitted' ? { source: 'page' } : {},
      });
    }
    const req = await insertCaptchaRequest(t.handle, {
      userId: t.userId,
      applicationId: application.id,
      imageRef: 'x',
    });
    await incrementCaptchaAttempt(t.handle, req.id, 'agent1');
    await incrementCaptchaAttempt(t.handle, req.id, 'agent1');
    await updateCaptchaRequest(t.handle, req.id, {
      tokenHash: 'secret-hash',
      humanAnswer: 'secret-answer',
      resolvedBy: 'agent1',
      resolvedAt: new Date('2026-11-01T09:59:00Z'),
    });

    const res = await app(t).request(`/applications/${application.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: application.id,
      status: 'applied',
      applied_at: '2026-11-01T10:00:00.000Z',
      confirmation_source: 'page',
      job: { id: job.id, title: 'Staff Engineer', company: 'Acme Robotics' },
      resume: { ref: `tenants/${t.id}/applications/${application.id}/resume.pdf` },
      unmet_requirements: ['Rust', 'CKA certification'],
    });
    // jsonb does not keep key order, so the list is compared by question.
    expect(
      [...body.form_answers].sort((x: { question: string }, y: { question: string }) =>
        x.question.localeCompare(y.question),
      ),
    ).toEqual([
      { question: 'Full name', status: 'filled', value: 'Mara Quill' },
      { question: 'Gender', status: 'skipped', value: null, skipped: 'self-identification' },
      { question: 'Optional note', status: 'blank', value: null },
      { question: 'Resume', status: 'attached', value: 'resume.pdf' },
      {
        question: 'Why do you want to work here?',
        status: 'filled',
        value: 'Because the work is interesting.',
      },
    ]);
    expect(body.activity.map((e: { action: string }) => e.action)).toEqual([
      'submission-started',
      'tailored',
      'filled',
      'submitted',
    ]);
    expect(body.activity[3]).toMatchObject({ actor: 'agent', detail: { source: 'page' } });
    expect(body.activity[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.captcha).toEqual([
      {
        id: req.id,
        stage: 'agent1',
        resolved_by: 'agent1',
        attempts: { agent1: 2, agent2: 0, human: 0 },
        created_at: expect.any(String),
        resolved_at: '2026-11-01T09:59:00.000Z',
        expired_at: null,
      },
    ]);
    // Reply tokens and answers never leave the server.
    expect(JSON.stringify(body)).not.toContain('secret-hash');
    expect(JSON.stringify(body)).not.toContain('secret-answer');
  });

  it('is 404 for another user’s application and for a malformed id', async () => {
    const t = await env.makeTenant();
    const other = await env.makeTenant();
    const theirs = await seed(other, 'Theirs');
    expect((await app(t).request(`/applications/${theirs.application.id}`)).status).toBe(404);
    expect((await app(t).request('/applications/not-a-uuid')).status).toBe(404);
    expect(
      (await app(t).request('/applications/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
  });
});
