import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  incrementCaptchaAttempt,
  insertApplication,
  insertCaptchaRequest,
  insertDemoMessage,
  insertInterview,
  insertInterviewSlot,
  insertOutgoingMessage,
  insertRun,
  insertRunCandidates,
  updateInterview,
  upsertEmailThread,
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

/** The demo flag has no application write path; the owner role flags the tenant for a test. */
async function setDemo(t: TestTenant, demo: boolean) {
  const { default: pg } = await import('pg');
  const owner = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test',
  });
  await owner.query('update tenants set demo = $2 where id = $1', [t.id, demo]);
  await owner.end();
}
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

describe('GET /applications/:id sections', () => {
  it('returns decision, threads, interviews with slot state, prep plan, feedback and negotiation', async () => {
    const t = await env.makeTenant();
    const co = await upsertCompany(t.handle, {
      name: 'Acme Robotics',
      ats: 'greenhouse',
      boardSlug: slug,
      createdBy: 'llm',
    });
    const { job } = await upsertJob(t.handle, {
      companyId: co.id,
      ats: 'greenhouse',
      atsJobId: `detail-${Date.now()}`,
      title: 'Principal Engineer',
      url: `https://boards.greenhouse.io/${slug}/jobs/detail-${Date.now()}`,
      locationMode: 'hybrid',
      payMin: 180000,
      payMax: 220000,
      currency: 'USD',
    });
    const { run } = await insertRun(t.handle, { userId: t.userId, date: '2026-11-05', targetN: 5 });
    await insertRunCandidates(t.handle, run.id, [
      {
        title: job.title,
        companyName: 'Acme Robotics',
        url: job.url,
        ats: 'greenhouse',
        atsJobId: job.atsJobId,
        rank: 1,
        selected: true,
        judgment: { apply: true, rationale: 'Strong platform match', fit: 5, seniority: 'staff' },
      },
    ]);
    const { application } = await insertApplication(t.handle, {
      userId: t.userId,
      jobId: job.id,
      runId: run.id,
      status: 'offer',
    });
    await updateApplication(t.handle, application.id, {
      negotiation: {
        posted_min: 180000,
        posted_max: 220000,
        floor: 170000,
        comparables: [],
        error: null,
      },
    } as never);
    const thread = await upsertEmailThread(t.handle, {
      userId: t.userId,
      gmailThreadId: `thr-${Date.now()}`,
      kind: 'interview',
      applicationId: application.id,
      subject: 'Interview times for Principal Engineer',
    });
    await insertDemoMessage(t.handle, {
      userId: t.userId,
      threadId: thread.gmailThreadId,
      fromAddress: 'rae@acme.test',
      fromName: 'Rae Recruiter',
      toAddress: 'mara@example.test',
      subject: 'Interview times for Principal Engineer',
      bodyText: 'Here are three times.',
    });
    await insertOutgoingMessage(t.handle, {
      userId: t.userId,
      applicationId: application.id,
      kind: 'follow_up',
      toAddress: 'rae@acme.test',
      subject: 'Following up',
      bodyText: 'Checking in.',
    });
    const { interview } = await insertInterview(t.handle, {
      userId: t.userId,
      applicationId: application.id,
      threadId: thread.id,
    });
    const day = 24 * 3600 * 1000;
    const s1 = await insertInterviewSlot(t.handle, {
      interviewId: interview.id,
      startsAt: new Date(Date.now() + day),
      endsAt: new Date(Date.now() + day + 3600e3),
      tokenHash: `h1-${Date.now()}`,
    });
    await insertInterviewSlot(t.handle, {
      interviewId: interview.id,
      startsAt: new Date(Date.now() + 2 * day),
      endsAt: new Date(Date.now() + 2 * day + 3600e3),
      tokenHash: `h2-${Date.now()}`,
      ttlSeconds: 1,
    });
    await updateInterview(t.handle, interview.id, {
      prepPlan: 'Likely questions: system design.',
      prepPlanStatus: 'ready',
      feedback: { notes: 'Went well', relayed: null, rating: 4 },
    });
    await new Promise((r) => setTimeout(r, 1200));

    const res = await app(t).request(`/applications/${application.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toMatchObject({
      title: 'Principal Engineer',
      company: 'Acme Robotics',
      location_mode: 'hybrid',
      pay_min: 180000,
      pay_max: 220000,
      currency: 'USD',
    });
    expect(body.decision).toEqual({ rationale: 'Strong platform match', seniority: 'staff' });
    expect(JSON.stringify(body)).not.toContain('"fit"');
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({
      subject: 'Interview times for Principal Engineer',
      kind: 'interview',
      compensation_flag: false,
    });
    // a real tenant's mail is not read from the simulated mailbox, even if rows exist for it
    expect(body.threads[0].messages).toEqual([]);
    await setDemo(t, true);
    try {
      const demoBody = await (await app(t).request(`/applications/${application.id}`)).json();
      expect(demoBody.threads[0].messages[0]).toMatchObject({
        from: 'Rae Recruiter <rae@acme.test>',
        body: 'Here are three times.',
      });
    } finally {
      await setDemo(t, false);
    }
    expect(body.outgoing[0]).toMatchObject({ kind: 'follow_up', subject: 'Following up' });
    expect(body.interviews).toHaveLength(1);
    expect(body.interviews[0].slots.map((x: { state: string }) => x.state)).toEqual([
      'open',
      'expired',
    ]);
    expect(body.interviews[0].slots[0].id).toBe(s1.id);
    expect(JSON.stringify(body)).not.toContain('h1-');
    expect(body.prep_plan).toEqual({
      interview_id: interview.id,
      status: 'ready',
      text: 'Likely questions: system design.',
    });
    expect(body.feedback).toMatchObject({ notes: 'Went well', rating: 4 });
    expect(body.negotiation).toMatchObject({ floor: 170000 });
  });

  it('returns empty sections and a null prep plan for a bare application', async () => {
    const t = await env.makeTenant();
    const { application } = await seed(t, 'Bare');
    const body = await (await app(t).request(`/applications/${application.id}`)).json();
    expect(body).toMatchObject({
      decision: null,
      threads: [],
      interviews: [],
      prep_plan: null,
      feedback: null,
      negotiation: null,
      activity_next: null,
    });
  });

  it('pages activity newest-first by cursor and rejects a bad cursor', async () => {
    const t = await env.makeTenant();
    const { application } = await seed(t, 'Busy');
    for (let i = 0; i < 55; i++) {
      await activity.logActivity(t.handle, {
        userId: t.userId,
        applicationId: application.id,
        actor: 'agent',
        action: `step-${i}`,
      });
    }
    const first = await (await app(t).request(`/applications/${application.id}`)).json();
    expect(first.activity).toHaveLength(50);
    expect(first.activity.at(-1).action).toBe('step-54');
    expect(first.activity_next).toEqual(expect.any(String));
    const second = await (
      await app(t).request(`/applications/${application.id}?activity_before=${first.activity_next}`)
    ).json();
    expect(second.activity.map((e: { action: string }) => e.action)).toEqual([
      'step-0',
      'step-1',
      'step-2',
      'step-3',
      'step-4',
    ]);
    expect(second.activity_next).toBeNull();
    expect(
      (await app(t).request(`/applications/${application.id}?activity_before=garbage`)).status,
    ).toBe(400);
  });
});
