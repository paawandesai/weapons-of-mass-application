import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  disconnectConnection,
  finishProfileBuild,
  getLatestProfile,
  getLatestProfileBuild,
  getProfileVersion,
  getUserById,
  insertProfileVersion,
  requireApprovedProfile,
  setApprovedProfileVersion,
  startProfileBuild,
} from '@wma/db';
import { FakeLlm } from '@wma/llm';
import type { ProfileDocument } from '@wma/shared';
import { executeProfileBuild } from '../src/jobs/profile-build';
import { runProfileBuild } from '../src/profile/build';
import type { DrivePort } from '../src/profile/bundle';
import { BuildError } from '../src/profile/types';
import { connect, setupEnv, type TestEnv, type TestTenant } from './helpers';
import clean from './fixtures/llm/clean.json';
import conflict from './fixtures/llm/date-conflict.json';
import invalid from './fixtures/llm/invalid-no-sources.json';
import recorded from './fixtures/llm/recorded-real.json';
import invented from './fixtures/llm/invented-employer.json';
import { GITHUB_TEXT, LINKEDIN_TEXT, RESUME_TEXT } from './fixtures/sources';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

async function tenantWith(
  sources: Array<'resume' | 'linkedin' | 'github'> = ['resume'],
): Promise<TestTenant> {
  const t = await env.makeTenant();
  if (sources.includes('resume')) await connect(t, 'resume', { text: RESUME_TEXT });
  if (sources.includes('linkedin'))
    await connect(t, 'linkedin', {
      url: 'https://www.linkedin.com/in/mara-quill',
      text: LINKEDIN_TEXT,
    });
  if (sources.includes('github'))
    await connect(t, 'github', { username: 'mara-quill', text: GITHUB_TEXT });
  return t;
}

const actions = async (t: TestTenant) =>
  (await activity.listByUser(t.handle, t.userId)).map((a) => a.action);

describe('profile build', () => {
  it('clean build: inserts version 1, built_from lists the sources, logs profile_built (rule 8, 10)', async () => {
    const t = await tenantWith(['resume', 'linkedin', 'github']);
    const llm = new FakeLlm([clean]);
    const r = await runProfileBuild(t.handle, t.userId, { llm });
    expect(r.version).toBe(1);
    expect(r.flags).toEqual([]);
    const row = await getProfileVersion(t.handle, t.userId, 1);
    expect(row.builtFrom).toEqual(['resume', 'linkedin', 'github']);
    const doc = row.document as ProfileDocument;
    expect(doc.work_history.map((w) => w.employer)).toEqual(['Google', 'Acme Corp']);
    // user-authored sections exist with defaults
    expect(doc.survey.daily_target).toBe(12);
    expect(doc.preferences.remote).toBe('any');
    // the model got the schema, versioned prompt id and tagged sources
    expect(llm.calls[0]!.prompt).toBe('profile-build/v1');
    expect(llm.calls[0]!.user).toContain('<source id="linkedin"');
  });

  it('job wrapper logs profile_built with {version, sources, flag_count} and marks the build done', async () => {
    const t = await tenantWith(['resume', 'linkedin', 'github']);
    const build = await startProfileBuild(t.handle, t.userId);
    const out = await executeProfileBuild(
      t.handle,
      { userId: t.userId, buildId: build.id },
      { llm: new FakeLlm([clean]) },
    );
    expect(out).toEqual({ version: 1, flags: 0 });
    const latest = await getLatestProfileBuild(t.handle, t.userId);
    expect(latest).toMatchObject({ state: 'done', version: 1 });
    const entry = (await activity.listByUser(t.handle, t.userId)).find(
      (a) => a.action === 'profile_built',
    )!;
    expect(entry.detail).toEqual({
      version: 1,
      sources: ['resume', 'linkedin', 'github'],
      flag_count: 0,
    });
  });

  it('invented employer: dropped, flagged in the stored document', async () => {
    const t = await tenantWith(['resume', 'linkedin', 'github']);
    const r = await runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([invented]) });
    expect(r.flags.map((f) => f.kind)).toEqual(['unsupported_entry']);
    const doc = (await getProfileVersion(t.handle, t.userId, 1)).document as ProfileDocument;
    expect(doc.work_history.map((w) => w.employer)).not.toContain('Initech');
    expect(doc.skills.map((s) => s.name)).not.toContain('Haskell');
    expect(doc.flags[0]).toMatchObject({ kind: 'unsupported_entry', value: 'Initech' });
  });

  it('a response recorded from the real model validates, builds, and yields the expected conflict flag', async () => {
    const t = await tenantWith(['resume', 'linkedin']);
    const r = await runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([recorded]) });
    expect(r.version).toBe(1);
    expect(r.flags.map((f) => f.kind)).toEqual(['date_conflict']);
  });

  it('date conflict: both entries kept, one flag', async () => {
    const t = await tenantWith(['resume', 'linkedin', 'github']);
    const r = await runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([conflict]) });
    expect(r.flags.filter((f) => f.kind === 'date_conflict')).toHaveLength(1);
    const doc = (await getProfileVersion(t.handle, t.userId, 1)).document as ProfileDocument;
    expect(doc.work_history.filter((w) => w.employer === 'Acme Corp')).toHaveLength(2);
  });

  it('partial LinkedIn: flagged, build completes, empty source is not sent to the model', async () => {
    const t = await tenantWith(['resume', 'github']);
    await connect(
      t,
      'linkedin',
      { url: 'https://www.linkedin.com/in/mara-quill', text: '' },
      'partial',
    );
    const llm = new FakeLlm([
      { ...clean, work_history: clean.work_history.map((w) => ({ ...w, sources: ['resume'] })) },
    ]);
    const r = await runProfileBuild(t.handle, t.userId, { llm });
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toMatchObject({ kind: 'partial_source', sources: ['linkedin'] });
    expect(llm.calls[0]!.user).not.toContain('<source id="linkedin"');
    expect(r.sources).toEqual(['resume', 'github']);
  });

  it('no resume: fails with profile_build_no_resume, calls no model, inserts nothing, logs profile_build_failed', async () => {
    const t = await tenantWith(['linkedin', 'github']);
    const llm = new FakeLlm([clean]);
    const build = await startProfileBuild(t.handle, t.userId);
    const out = await executeProfileBuild(
      t.handle,
      { userId: t.userId, buildId: build.id },
      { llm },
    );
    expect(out).toEqual({ reason: 'profile_build_no_resume' });
    expect(llm.calls).toHaveLength(0);
    await expect(getProfileVersion(t.handle, t.userId, 1)).rejects.toThrow();
    expect(await getLatestProfileBuild(t.handle, t.userId)).toMatchObject({
      state: 'failed',
      reason: 'profile_build_no_resume',
    });
    const entry = (await activity.listByUser(t.handle, t.userId)).find(
      (a) => a.action === 'profile_build_failed',
    )!;
    expect(entry.detail).toMatchObject({ reason: 'profile_build_no_resume' });
  });

  it('a resume with no extracted text counts as no resume', async () => {
    const t = await tenantWith([]);
    await connect(t, 'resume', { text: '   ' });
    await expect(
      runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([clean]) }),
    ).rejects.toMatchObject({
      reason: 'profile_build_no_resume',
    });
  });

  it('disconnected resume is not read by the next build (task 5.3)', async () => {
    const t = await tenantWith(['resume', 'github']);
    const llm = new FakeLlm([clean]);
    await runProfileBuild(t.handle, t.userId, { llm });
    expect(llm.calls[0]!.user).toContain('Mara Quill');
    await disconnectConnection(t.handle, t.userId, 'resume');
    const llm2 = new FakeLlm([clean]);
    await expect(runProfileBuild(t.handle, t.userId, { llm: llm2 })).rejects.toBeInstanceOf(
      BuildError,
    );
    expect(llm2.calls).toHaveLength(0);
  });

  it('a disconnected optional source is excluded from the bundle', async () => {
    const t = await tenantWith(['resume', 'linkedin', 'github']);
    await disconnectConnection(t.handle, t.userId, 'linkedin');
    const llm = new FakeLlm([
      { ...clean, work_history: clean.work_history.map((w) => ({ ...w, sources: ['resume'] })) },
    ]);
    const r = await runProfileBuild(t.handle, t.userId, { llm });
    expect(r.sources).toEqual(['resume', 'github']);
    expect(llm.calls[0]!.user).not.toContain('<source id="linkedin"');
  });

  it('rule 1: an invalid response is retried once and the second reply is used', async () => {
    const t = await tenantWith(['resume', 'github']);
    const llm = new FakeLlm([invalid, clean]);
    const r = await runProfileBuild(t.handle, t.userId, { llm });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.user).toContain('previous reply was rejected');
    expect(r.version).toBe(1);
  });

  it('rule 1: two invalid responses fail with profile_build_invalid_output', async () => {
    const t = await tenantWith(['resume']);
    const llm = new FakeLlm([invalid]);
    const build = await startProfileBuild(t.handle, t.userId);
    const out = await executeProfileBuild(
      t.handle,
      { userId: t.userId, buildId: build.id },
      { llm },
    );
    expect(out).toEqual({ reason: 'profile_build_invalid_output' });
    expect(llm.calls).toHaveLength(2);
    expect(await actions(t)).toContain('profile_build_failed');
    expect(await actions(t)).not.toContain('profile_built');
  });

  it('a model transport failure fails the build with profile_build_llm_error', async () => {
    const t = await tenantWith(['resume']);
    const build = await startProfileBuild(t.handle, t.userId);
    const out = await executeProfileBuild(
      t.handle,
      { userId: t.userId, buildId: build.id },
      { llm: new FakeLlm([new Error('overloaded')]) },
    );
    expect(out).toEqual({ reason: 'profile_build_llm_error' });
  });

  it('includes Drive files as drive:<id> sources through the injected port', async () => {
    const t = await tenantWith(['resume']);
    await connect(t, 'drive', { folder_ids: ['f1'] });
    const drive: DrivePort = {
      collectFiles: async (_h, _u, ids) => {
        expect(ids).toEqual(['f1']);
        return {
          files: [
            { id: 'abc', name: 'Notes', text: 'Side project: tinyqueue. Skills: Kubernetes' },
          ],
          failed: [],
        };
      },
    };
    const llm = new FakeLlm([clean]);
    const r = await runProfileBuild(t.handle, t.userId, { llm, drive });
    expect(r.sources).toEqual(['resume', 'drive:abc']);
    expect(llm.calls[0]!.user).toContain('<source id="drive:abc" kind="drive">');
  });

  it('a failing Drive read becomes a partial_source flag and the build continues', async () => {
    const t = await tenantWith(['resume']);
    await connect(t, 'drive', { folder_ids: ['f1'] });
    const drive: DrivePort = {
      collectFiles: async () => {
        throw new Error('quota');
      },
    };
    const r = await runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([clean]), drive });
    expect(r.flags.map((f) => f.kind)).toContain('partial_source');
  });

  it('keeps the readable Drive files and flags only the file that failed', async () => {
    const t = await tenantWith(['resume']);
    await connect(t, 'drive', { folder_ids: ['f1'] });
    const drive: DrivePort = {
      collectFiles: async () => ({
        files: [{ id: 'ok1', name: 'Notes', text: 'Side project: tinyqueue.' }],
        failed: [{ id: 'bad1', name: 'Broken doc' }],
      }),
    };
    const llm = new FakeLlm([clean]);
    const r = await runProfileBuild(t.handle, t.userId, { llm, drive });
    expect(r.sources).toEqual(['resume', 'drive:ok1']);
    const partial = r.flags.filter((f) => f.kind === 'partial_source');
    expect(partial.map((f) => f.value)).toEqual(['drive:bad1']);
    expect(partial[0]!.message).toContain('Broken doc');
  });

  it('a selected Drive source that yields no usable files becomes an empty partial source', async () => {
    const t = await tenantWith(['resume']);
    await connect(t, 'drive', { folder_ids: ['f1', 'f2'] });
    const drive: DrivePort = { collectFiles: async () => ({ files: [], failed: [] }) };
    const llm = new FakeLlm([clean]);
    const r = await runProfileBuild(t.handle, t.userId, { llm, drive });
    expect(r.sources).toEqual(['resume']);
    const partial = r.flags.filter((f) => f.kind === 'partial_source');
    expect(partial.map((f) => f.value)).toEqual(['drive']);
    expect(llm.calls[0]!.user).not.toContain('kind="drive"');
  });
});

describe('rebuild and approval (rule 8, tenancy rule 10)', () => {
  it('rebuild inserts max+1, leaves approved_profile_version untouched, keeps survey answers', async () => {
    const t = await tenantWith(['resume', 'linkedin', 'github']);
    await runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([clean]) });
    const v1 = (await getProfileVersion(t.handle, t.userId, 1)).document as ProfileDocument;
    // user answers the survey and approves version 2 (edit), then a rebuild happens
    const v2 = await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: {
        ...v1,
        survey: { ...v1.survey, target_roles: ['Staff Engineer'], salary_floor: 90000 },
      },
    });
    await setApprovedProfileVersion(t.handle, t.userId, v2.version);
    const approvedAt = (await getUserById(t.handle, t.userId)).approvedProfileAt;
    expect(approvedAt).toBeInstanceOf(Date);

    const r = await runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([clean]) });
    expect(r.version).toBe(3);
    expect(await requireApprovedProfile(t.handle, t.userId)).toBe(2);
    const user = await getUserById(t.handle, t.userId);
    expect(user.approvedProfileVersion).toBe(2);
    expect(user.approvedProfileAt).toEqual(approvedAt);
    const v3 = (await getProfileVersion(t.handle, t.userId, 3)).document as ProfileDocument;
    expect(v3.survey.target_roles).toEqual(['Staff Engineer']);
    expect(v3.survey.salary_floor).toBe(90000);
  });
});

describe('publishing is fenced and atomic', () => {
  it('a build that is no longer running publishes nothing and records nothing', async () => {
    const t = await tenantWith(['resume']);
    const build = await startProfileBuild(t.handle, t.userId);
    // The reservation was released (for example the job was declared dead and replaced).
    await finishProfileBuild(t.handle, build.id, {
      state: 'failed',
      reason: 'profile_build_timeout',
    });
    const out = await executeProfileBuild(
      t.handle,
      { userId: t.userId, buildId: build.id },
      { llm: new FakeLlm([clean]) },
    );
    expect(out).toEqual({ reason: 'profile_build_superseded' });
    await expect(getLatestProfile(t.handle, t.userId)).rejects.toThrow();
    expect(await actions(t)).toEqual([]);
    expect(await getLatestProfileBuild(t.handle, t.userId)).toMatchObject({
      state: 'failed',
      reason: 'profile_build_timeout',
    });
  });

  it('commits the profile, the done status and the profile_built entry together', async () => {
    const t = await tenantWith(['resume']);
    const build = await startProfileBuild(t.handle, t.userId);
    await executeProfileBuild(
      t.handle,
      { userId: t.userId, buildId: build.id },
      { llm: new FakeLlm([clean]) },
    );
    expect(await getLatestProfileBuild(t.handle, t.userId)).toMatchObject({
      state: 'done',
      version: 1,
    });
    expect(await actions(t)).toEqual(['profile_built']);
  });

  it('a failed run records failed status and profile_build_failed once, and no profile', async () => {
    const t = await tenantWith(['resume']);
    const build = await startProfileBuild(t.handle, t.userId);
    const out = await executeProfileBuild(
      t.handle,
      { userId: t.userId, buildId: build.id },
      { llm: new FakeLlm([invalid, invalid]) },
    );
    expect(out).toEqual({ reason: 'profile_build_invalid_output' });
    expect(await actions(t)).toEqual(['profile_build_failed']);
    await expect(getLatestProfile(t.handle, t.userId)).rejects.toThrow();
  });

  it('a survey save racing a build is never overwritten by stale carried sections', async () => {
    for (let i = 0; i < 6; i++) {
      const t = await tenantWith(['resume']);
      await runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([clean]) });
      const v1 = (await getProfileVersion(t.handle, t.userId, 1)).document as ProfileDocument;
      const withSurvey: ProfileDocument = {
        ...v1,
        survey: { ...v1.survey, target_roles: ['Staff Engineer'], salary_floor: 123000 },
      };
      const [built] = await Promise.all([
        runProfileBuild(t.handle, t.userId, { llm: new FakeLlm([clean]) }),
        insertProfileVersion(t.handle, { userId: t.userId, document: withSurvey }),
      ]);
      // Both succeeded with distinct, consecutive versions...
      expect([2, 3]).toContain(built.version);
      const latest = (await getLatestProfile(t.handle, t.userId)).document as ProfileDocument;
      // ...and whichever landed last still carries the survey answers.
      expect(latest.survey.target_roles).toEqual(['Staff Engineer']);
      expect(latest.survey.salary_floor).toBe(123000);
    }
  });
});
