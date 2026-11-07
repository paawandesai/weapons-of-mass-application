import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  insertApplication,
  insertRun,
  insertRunCandidates,
  insertProfileVersion,
  listRunCandidates,
  schema,
  setApprovedProfileVersion,
  transitionRun,
  updateRun,
  upsertCompany,
  upsertJob,
} from '../src';
import { doc, pgErrorMessage, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
let A: Awaited<ReturnType<TestEnv['makeTenant']>>;
let B: Awaited<ReturnType<TestEnv['makeTenant']>>;
const tag = `rf-${Date.now()}`;

beforeAll(async () => {
  env = await setupEnv();
  A = await env.makeTenant();
  B = await env.makeTenant();
});
afterAll(async () => {
  await env.owner.query('delete from tenants where id = any($1::uuid[])', [
    env.tenants.map((t) => t.id),
  ]);
  await env.owner.query('delete from companies where lower(name) like $1', [`${tag}%`]);
  await env.owner.query('delete from companies where board_slug like $1', [`${tag}%`]);
  await env.cleanup();
});

describe('tenant-qualified parent references', () => {
  it("another tenant cannot attach run candidates to a tenant's run", async () => {
    const { run } = await insertRun(A.handle, { userId: A.userId, date: '2026-03-01', targetN: 3 });
    const msg = await pgErrorMessage(
      insertRunCandidates(B.handle, run.id, [
        { title: 'x', companyName: 'y', url: 'https://x.test/1' },
      ]),
    );
    expect(msg).toContain('run_candidates_tenant_id_run_id_runs_tenant_id_id_fk');
    // deleting A's run therefore can never reach another tenant's rows
    await insertRunCandidates(A.handle, run.id, [
      { title: 'x', companyName: 'y', url: 'https://x.test/1' },
    ]);
    await env.owner.query('delete from runs where id = $1', [run.id]);
    expect(await listRunCandidates(A.handle, run.id)).toEqual([]);
  });

  it("another tenant cannot point an application at a tenant's run", async () => {
    const { run } = await insertRun(A.handle, { userId: A.userId, date: '2026-03-02', targetN: 3 });
    const { job } = await upsertJob(B.handle, { title: 'J', url: `https://x.test/${tag}-b` });
    const msg = await pgErrorMessage(
      insertApplication(B.handle, { userId: B.userId, jobId: job.id, runId: run.id }),
    );
    expect(msg).toContain('applications_tenant_id_run_id_runs_tenant_id_id_fk');
  });

  it("another tenant cannot log activity against a tenant's application", async () => {
    const { job } = await upsertJob(A.handle, { title: 'J', url: `https://x.test/${tag}-a` });
    const { application } = await insertApplication(A.handle, { userId: A.userId, jobId: job.id });
    const msg = await pgErrorMessage(
      activity.logActivity(B.handle, {
        userId: B.userId,
        applicationId: application.id,
        actor: 'agent',
        action: 'x',
      }),
    );
    expect(msg).toContain('activity_log_tenant_id_application_id_applications_tenant_id');
  });

  it('deleting a run keeps the application and nulls only its run reference', async () => {
    const { run } = await insertRun(A.handle, { userId: A.userId, date: '2026-03-03', targetN: 3 });
    const { job } = await upsertJob(A.handle, { title: 'J', url: `https://x.test/${tag}-c` });
    const { application } = await insertApplication(A.handle, {
      userId: A.userId,
      jobId: job.id,
      runId: run.id,
    });
    await env.owner.query('delete from runs where id = $1', [run.id]);
    const after = await getApplication(A.handle, application.id);
    expect(after).toMatchObject({ id: application.id, runId: null });
    expect(after!.tenantId).toBe(A.id);
  });
});

describe('compensation amounts', () => {
  it('store values beyond signed 32-bit integers', async () => {
    const { job } = await upsertJob(A.handle, {
      title: 'Big pay',
      url: `https://x.test/${tag}-pay`,
      payMin: 2_500_000_000,
      payMax: 9_000_000_000_000,
      currency: 'VND',
    });
    expect(job.payMin).toBe(2_500_000_000);
    expect(job.payMax).toBe(9_000_000_000_000);
  });
});

describe('unresolved companies', () => {
  it('concurrent inserts of one name, in any case, produce a single row', async () => {
    const names = [`${tag} Quartz`, `${tag} QUARTZ`, `${tag} quartz`, `${tag} Quartz`];
    const rows = await Promise.all(
      names.flatMap((name, i) => [
        upsertCompany(A.handle, { name, createdBy: 'llm' }),
        upsertCompany(B.handle, { name: names[(i + 1) % names.length]!, createdBy: 'llm' }),
      ]),
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    const stored = await env.owner.query(
      'select id from companies where ats is null and lower(name) = lower($1)',
      [`${tag} Quartz`],
    );
    expect(stored.rowCount).toBe(1);
  });

  it('the index rejects a second unresolved row inserted directly', async () => {
    await upsertCompany(A.handle, { name: `${tag} Direct`, createdBy: 'llm' });
    const msg = await pgErrorMessage(
      A.handle.run((tx) =>
        tx.insert(schema.companies).values({ name: `${tag} DIRECT`, createdBy: 'user' }),
      ),
    );
    expect(msg).toContain('companies_unresolved_name_key');
  });
});

describe('board regions', () => {
  it('the same slug on the EU and default host are two boards; the same region is one', async () => {
    const slug = `${tag}-lever`;
    const us = await upsertCompany(A.handle, {
      name: 'Region Co',
      ats: 'lever',
      boardSlug: slug,
      boardUrl: `https://jobs.lever.co/${slug}`,
      createdBy: 'user',
    });
    const eu = await upsertCompany(A.handle, {
      name: 'Region Co',
      ats: 'lever',
      boardSlug: slug,
      boardRegion: 'eu',
      boardUrl: `https://jobs.eu.lever.co/${slug}`,
      createdBy: 'user',
    });
    const again = await upsertCompany(B.handle, {
      name: 'Region Co',
      ats: 'lever',
      boardSlug: slug,
      boardRegion: 'eu',
      boardUrl: `https://jobs.eu.lever.co/${slug}`,
      createdBy: 'user',
    });
    expect(us.id).not.toBe(eu.id);
    expect(again.id).toBe(eu.id);
    expect(eu.boardRegion).toBe('eu');
    expect(us.boardRegion).toBe('');
  });
});

describe('scheduler enumeration through the application role', () => {
  it('runRoster returns users with an approved profile and their hour, nothing else', async () => {
    const row = await insertProfileVersion(A.handle, { userId: A.userId, document: doc });
    await setApprovedProfileVersion(A.handle, A.userId, row.version);
    // the application role cannot read users across tenants directly
    await expect(env.db.pool.query('select id from users')).rejects.toThrow();
    const roster = await env.db.runRoster();
    expect(roster).toContainEqual({ tenantId: A.id, userId: A.userId, runHour: 8 });
    expect(roster.map((r) => r.userId)).not.toContain(B.userId);
    expect(Object.keys(roster[0]!).sort()).toEqual(['runHour', 'tenantId', 'userId']);
  });

  it('tenantsWithRunsBefore lists tenants that own runs before the cutoff, and only those', async () => {
    await insertRun(A.handle, { userId: A.userId, date: '2020-01-01', targetN: 3 });
    await insertRun(B.handle, { userId: B.userId, date: '2026-12-31', targetN: 3 });
    const old = await env.db.tenantsWithRunsBefore('2026-01-01');
    expect(old).toContain(A.id);
    expect(old).not.toContain(B.id);
  });

  it('only the application role may call the functions', async () => {
    const r = await env.owner.query(
      `select has_function_privilege('public', 'wma_run_roster()', 'execute') as pub,
              has_function_privilege('wma_app', 'wma_run_roster()', 'execute') as app,
              has_function_privilege('public', 'wma_stale_runs(date)', 'execute') as pub2,
              has_function_privilege('wma_app', 'wma_stale_runs(date)', 'execute') as app2`,
    );
    expect(r.rows[0]).toEqual({ pub: false, app: true, pub2: false, app2: true });
  });
});

describe('transitionRun', () => {
  it('applies the patch only while the row still has the expected state', async () => {
    const { run } = await insertRun(A.handle, {
      userId: A.userId,
      date: '2026-03-10',
      targetN: 3,
      status: 'skipped_no_profile',
      dispatchState: 'queued',
    });
    expect(run.dispatchState).toBe('queued');
    const won = await transitionRun(
      A.handle,
      run.id,
      { status: 'skipped_no_profile' },
      { status: 'running', step: 'queued' },
    );
    expect(won).toMatchObject({ status: 'running', step: 'queued' });
    const lost = await transitionRun(
      A.handle,
      run.id,
      { status: 'skipped_no_profile' },
      { status: 'running', step: 'start' },
    );
    expect(lost).toBeNull();
    // step and dispatch state narrow it further
    expect(
      await transitionRun(
        A.handle,
        run.id,
        { status: 'running', step: 'queued', dispatchState: ['failed', null] },
        { dispatchState: 'queued' },
      ),
    ).toBeNull();
    await updateRun(A.handle, run.id, { dispatchState: 'failed' });
    expect(
      await transitionRun(
        A.handle,
        run.id,
        { status: 'running', step: 'queued', dispatchState: ['failed', null] },
        { dispatchState: 'dispatched' },
      ),
    ).toMatchObject({ dispatchState: 'dispatched' });
  });
});
