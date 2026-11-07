import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  getAtsCredential,
  getCaptchaRequest,
  getCaptchaRequestByTokenHash,
  getCompany,
  getJob,
  getRun,
  getUserCompany,
  hasOpenHumanCaptcha,
  incrementCaptchaAttempt,
  insertApplication,
  insertAtsCredential,
  insertCaptchaRequest,
  insertRun,
  insertRunCandidates,
  listApplicationJobKeys,
  listRunCandidates,
  listUserCompanies,
  lockForAttempt,
  markAtsCredentialRejected,
  removeUserCompany,
  schema,
  restoreUserCompany,
  updateApplication,
  updateCaptchaRequest,
  updateRun,
  upsertCompany,
  upsertJob,
  upsertUserCompany,
} from '../src';
import { makeApplication, pgErrorMessage, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
let A: Awaited<ReturnType<TestEnv['makeTenant']>>;
let B: Awaited<ReturnType<TestEnv['makeTenant']>>;
const slug = `acme-${Date.now()}`;

beforeAll(async () => {
  env = await setupEnv();
  A = await env.makeTenant();
  B = await env.makeTenant();
});
afterAll(async () => {
  // Tenants first: user_companies and ats_credentials reference the shared companies.
  await env.owner.query('delete from tenants where id = any($1::uuid[])', [[A.id, B.id]]);
  await env.owner.query('delete from companies where board_slug like $1', [`${slug}%`]);
  await env.cleanup();
});

describe('companies (global, no RLS)', () => {
  it('upserts one row per (ats, board_slug) and is visible to every tenant', async () => {
    const c1 = await upsertCompany(A.handle, {
      name: 'Acme',
      ats: 'greenhouse',
      boardSlug: slug,
      boardUrl: `https://boards.greenhouse.io/${slug}`,
      createdBy: 'llm',
    });
    const c2 = await upsertCompany(B.handle, {
      name: 'Acme Inc',
      ats: 'greenhouse',
      boardSlug: slug,
      createdBy: 'user',
    });
    expect(c2.id).toBe(c1.id);
    expect(c2.name).toBe('Acme');
    expect((await getCompany(B.handle, c1.id))?.boardSlug).toBe(slug);
  });

  it('keeps one unresolved row per name and allows the same slug on a different ATS', async () => {
    const name = `Ghost ${slug}`;
    const u1 = await upsertCompany(A.handle, {
      name,
      createdBy: 'llm',
      unresolvedUntil: new Date(),
    });
    const u2 = await upsertCompany(A.handle, { name: name.toUpperCase(), createdBy: 'hn' });
    expect(u2.id).toBe(u1.id);
    const lever = await upsertCompany(A.handle, {
      name: 'Acme',
      ats: 'lever',
      boardSlug: slug,
      createdBy: 'llm',
    });
    expect(lever.ats).toBe('lever');
    await env.owner.query('delete from companies where id = $1', [u1.id]);
  });

  it('rejects a duplicate (ats, board_slug) inserted directly', async () => {
    await upsertCompany(A.handle, {
      name: 'D',
      ats: 'ashby',
      boardSlug: `${slug}-d`,
      createdBy: 'llm',
    });
    const msg = await pgErrorMessage(
      env.owner.query(
        `insert into companies (name, ats, board_slug, created_by) values ('D2','ashby',$1,'llm')`,
        [`${slug}-d`],
      ),
    );
    expect(msg).toContain('companies_ats_board_slug_key');
  });
});

describe('user_companies', () => {
  it('round-trips, never resurrects a removed company, restores on request, hides from other tenants', async () => {
    const company = await upsertCompany(A.handle, {
      name: 'Acme',
      ats: 'greenhouse',
      boardSlug: slug,
      createdBy: 'llm',
    });
    const first = await upsertUserCompany(A.handle, {
      userId: A.userId,
      companyId: company.id,
      source: 'llm',
      reason: 'strong match',
    });
    expect(first.created).toBe(true);
    await removeUserCompany(A.handle, A.userId, company.id);
    const again = await upsertUserCompany(A.handle, {
      userId: A.userId,
      companyId: company.id,
      source: 'llm',
    });
    expect(again.created).toBe(false);
    expect(again.row.removedAt).not.toBeNull();
    expect(await listUserCompanies(A.handle, A.userId)).toEqual([]);
    expect(await listUserCompanies(A.handle, A.userId, { includeRemoved: true })).toHaveLength(1);
    await restoreUserCompany(A.handle, A.userId, company.id);
    expect((await listUserCompanies(A.handle, A.userId))[0]!.company.id).toBe(company.id);
    expect(await getUserCompany(B.handle, A.userId, company.id)).toBeNull();
  });
});

describe('runs and run_candidates', () => {
  it('allows one non-failed run per (user, date) and releases the date when it fails', async () => {
    const r1 = await insertRun(A.handle, { userId: A.userId, date: '2026-11-01', targetN: 12 });
    expect(r1.created).toBe(true);
    const r2 = await insertRun(A.handle, { userId: A.userId, date: '2026-11-01', targetN: 12 });
    expect(r2.created).toBe(false);
    expect(r2.run.id).toBe(r1.run.id);
    await updateRun(A.handle, r1.run.id, { status: 'failed', error: 'boom', step: 'judge' });
    const r3 = await insertRun(A.handle, { userId: A.userId, date: '2026-11-01', targetN: 12 });
    expect(r3.created).toBe(true);
    expect(r3.run.id).not.toBe(r1.run.id);
    expect(await getRun(B.handle, r3.run.id)).toBeNull();
  });

  it('stores candidates in rank order with the judgment', async () => {
    const { run } = await insertRun(A.handle, { userId: A.userId, date: '2026-11-02', targetN: 2 });
    await insertRunCandidates(A.handle, run.id, [
      { title: 'c', companyName: 'C', url: 'https://x.test/c', exclusionReason: 'unjudged' },
      { title: 'b', companyName: 'B', url: 'https://x.test/b', rank: 2, judgment: { fit: 3 } },
      {
        title: 'a',
        companyName: 'A',
        url: 'https://x.test/a',
        rank: 1,
        selected: true,
        judgment: { fit: 5 },
        promptVersion: 'apply-decision@v1',
        model: 'm',
      },
    ]);
    const rows = await listRunCandidates(A.handle, run.id);
    expect(rows.map((r) => r.title)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).toMatchObject({ selected: true, promptVersion: 'apply-decision@v1' });
    expect(rows[2]!.judgment).toBeNull();
    expect(await listRunCandidates(B.handle, run.id)).toEqual([]);
  });
});

describe('jobs and applications', () => {
  it('dedupes jobs by (ats, ats_job_id) and by url, and applications by (user, job)', async () => {
    const j1 = await upsertJob(A.handle, {
      ats: 'lever',
      atsJobId: 'job-1',
      title: 'Eng',
      url: 'https://jobs.lever.co/x/job-1',
    });
    const j2 = await upsertJob(A.handle, {
      ats: 'lever',
      atsJobId: 'job-1',
      title: 'Eng again',
      url: 'https://jobs.lever.co/x/job-1-other',
    });
    expect(j1.created).toBe(true);
    expect(j2.created).toBe(false);
    expect(j2.job.id).toBe(j1.job.id);
    const j3 = await upsertJob(A.handle, { title: 'Eng', url: 'https://jobs.lever.co/x/job-1' });
    expect(j3.job.id).toBe(j1.job.id);

    const a1 = await insertApplication(A.handle, { userId: A.userId, jobId: j1.job.id });
    const a2 = await insertApplication(A.handle, { userId: A.userId, jobId: j1.job.id });
    expect(a1.created).toBe(true);
    expect(a2.created).toBe(false);
    expect(a1.application).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      formAnswers: {},
      unmetRequirements: [],
    });
    const keys = await listApplicationJobKeys(A.handle, A.userId);
    expect(keys).toContainEqual({
      applicationId: a1.application.id,
      ats: 'lever',
      atsJobId: 'job-1',
      url: 'https://jobs.lever.co/x/job-1',
    });
    expect(await getJob(B.handle, j1.job.id)).toBeNull();
    expect(await getApplication(B.handle, a1.application.id)).toBeNull();
    expect(await listApplicationJobKeys(B.handle, A.userId)).toEqual([]);
  });

  it('updates fields, keeps the run reference nullable, and links activity entries', async () => {
    const { application } = await makeApplication(A);
    const updated = await updateApplication(A.handle, application.id, {
      status: 'applied',
      appliedAt: new Date(),
      confirmationSource: 'page',
      formAnswers: { 'Why us?': 'because' },
    });
    expect(updated).toMatchObject({ status: 'applied', confirmationSource: 'page', runId: null });
    await activity.logActivity(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      actor: 'agent',
      action: 'submitted',
    });
    expect(await activity.listByApplication(A.handle, application.id)).toHaveLength(1);
  });

  it('rejects an activity entry for an application that does not exist', async () => {
    const msg = await pgErrorMessage(
      activity.logActivity(A.handle, {
        userId: A.userId,
        applicationId: crypto.randomUUID(),
        actor: 'agent',
        action: 'x',
      }),
    );
    expect(msg).toContain('activity_log_tenant_id_application_id_applications_tenant_id');
  });

  it('refuses a row stamped with another tenant (RLS)', async () => {
    const msg = await pgErrorMessage(
      B.handle.run((tx) =>
        tx.insert(schema.jobs).values({ tenantId: A.id, title: 't', url: 'https://x.test/rls' }),
      ),
    );
    expect(msg).toContain('row-level security');
  });
});

describe('lockForAttempt', () => {
  it('returns null while another transaction holds the row, the row once it is released', async () => {
    const { application } = await makeApplication(A);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));

    const holder = A.handle.transaction(async (h) => {
      const row = await lockForAttempt(h, application.id);
      expect(row?.id).toBe(application.id);
      locked();
      await gate;
    });
    await holding;

    expect(await lockForAttempt(A.handle, application.id)).toBeNull();
    release();
    await holder;
    expect((await lockForAttempt(A.handle, application.id))?.id).toBe(application.id);
  });

  it('returns null for a missing id and for another tenant', async () => {
    const { application } = await makeApplication(A);
    expect(await lockForAttempt(A.handle, crypto.randomUUID())).toBeNull();
    expect(await lockForAttempt(B.handle, application.id)).toBeNull();
  });
});

describe('ats_credentials', () => {
  it('inserts, rejects a duplicate (user, ats, company), and marks rejection', async () => {
    const company = await upsertCompany(A.handle, {
      name: 'Cred Co',
      ats: 'ashby',
      boardSlug: `${slug}-cred`,
      createdBy: 'llm',
    });
    const input = {
      userId: A.userId,
      ats: 'ashby' as const,
      companyId: company.id,
      username: 'me@example.test',
      vaultRef: `ashby:${company.id}`,
    };
    const row = await insertAtsCredential(A.handle, input);
    expect(row.rejectedAt).toBeNull();
    const msg = await pgErrorMessage(insertAtsCredential(A.handle, input));
    expect(msg).toContain('ats_credentials_user_ats_company_key');
    await markAtsCredentialRejected(A.handle, row.id);
    expect(
      (await getAtsCredential(A.handle, A.userId, 'ashby', company.id))?.rejectedAt,
    ).not.toBeNull();
    expect(await getAtsCredential(B.handle, A.userId, 'ashby', company.id)).toBeNull();
  });
});

describe('captcha_requests', () => {
  it('goes through agent1, agent2 and human to resolved, and is invisible to other tenants', async () => {
    const { application } = await makeApplication(A);
    const req = await insertCaptchaRequest(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      imageRef: 'tenants/x/applications/y/captcha-1.png',
    });
    expect(req).toMatchObject({ stage: 'agent1', attempts: { agent1: 0, agent2: 0, human: 0 } });

    await incrementCaptchaAttempt(A.handle, req.id, 'agent1');
    await incrementCaptchaAttempt(A.handle, req.id, 'agent1');
    const s2 = await updateCaptchaRequest(A.handle, req.id, { stage: 'agent2' });
    expect(s2).toMatchObject({ stage: 'agent2', attempts: { agent1: 2, agent2: 0, human: 0 } });
    await incrementCaptchaAttempt(A.handle, req.id, 'agent2');

    const token = 'single-use-token';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();
    expect(await hasOpenHumanCaptcha(A.handle, A.userId, now)).toBe(false);
    await updateCaptchaRequest(A.handle, req.id, {
      stage: 'human',
      tokenHash,
      expiresAt: new Date(now.getTime() + 900_000),
    });
    expect(await hasOpenHumanCaptcha(A.handle, A.userId, now)).toBe(true);
    expect((await getCaptchaRequestByTokenHash(A.handle, tokenHash))?.id).toBe(req.id);
    expect(await getCaptchaRequestByTokenHash(B.handle, tokenHash)).toBeNull();

    // The public page knows only the token: the tenant comes from the pre-tenant lookup.
    expect(await env.db.resolveCaptchaToken(tokenHash)).toEqual({
      tenantId: A.id,
      requestId: req.id,
    });
    expect(await env.db.resolveCaptchaToken('0'.repeat(64))).toBeNull();

    await updateCaptchaRequest(A.handle, req.id, { humanAnswer: 'x7Kq' });
    const done = await updateCaptchaRequest(A.handle, req.id, {
      resolvedBy: 'human',
      resolvedAt: new Date(),
    });
    expect(done).toMatchObject({ stage: 'human', resolvedBy: 'human', humanAnswer: 'x7Kq' });
    expect(await hasOpenHumanCaptcha(A.handle, A.userId, now)).toBe(false);
    expect(await getCaptchaRequest(B.handle, req.id)).toBeNull();
  });

  it('records expiry and treats an expired human request as not open', async () => {
    const { application } = await makeApplication(A);
    const req = await insertCaptchaRequest(A.handle, {
      userId: A.userId,
      applicationId: application.id,
      stage: 'human',
    });
    const now = new Date();
    await updateCaptchaRequest(A.handle, req.id, {
      expiresAt: new Date(now.getTime() + 900_000),
    });
    expect(await hasOpenHumanCaptcha(A.handle, A.userId, now)).toBe(true);
    await updateCaptchaRequest(A.handle, req.id, { expiredAt: now });
    expect(await hasOpenHumanCaptcha(A.handle, A.userId, now)).toBe(false);
  });

  it("rejects a request for another tenant's application", async () => {
    const { application } = await makeApplication(A);
    const msg = await pgErrorMessage(
      insertCaptchaRequest(B.handle, { userId: B.userId, applicationId: application.id }),
    );
    expect(msg).toMatch(/foreign key|Failed query/);
  });
});
