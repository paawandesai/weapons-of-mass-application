import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  finishProfileBuild,
  getLatestProfileBuild,
  getProfileVersion,
  getUserById,
  insertProfileVersion,
  requireApprovedProfile,
  startProfileBuild,
  upsertConnection,
} from '@wma/db';
import { profileDocumentSchema, type ProfileDocument, type ProfileFlag } from '@wma/shared';
import fixture from '../../../packages/shared/test/fixtures/profile.full.json';
import { createProfileRoutes } from '../src/routes/profile';
import type { BuildQueue, JobState, ProfileBuildJobData } from '../src/services/queue';
import { BUILD_STALE_MS, getBuildStatus, requestProfileBuild } from '../src/services/builds';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const baseDoc = (): ProfileDocument => ({
  ...profileDocumentSchema.parse(structuredClone(fixture)),
  flags: [],
});
const flag = (kind: ProfileFlag['kind'], over: Partial<ProfileFlag> = {}): ProfileFlag => ({
  id: `f-${Math.random().toString(36).slice(2)}`,
  kind,
  path: null,
  message: `${kind} message`,
  sources: ['resume'],
  resolved: false,
  ...over,
});

/** In-memory queue: `states` answers jobState per build id (default: a live, queued job). */
function fakeQueue(sent: ProfileBuildJobData[] = [], states: Record<string, JobState | null> = {}) {
  const queue: BuildQueue = {
    enqueueProfileBuild: async (d) => void sent.push(d),
    jobState: async (id) => (id in states ? states[id]! : 'created'),
  };
  return queue;
}

function setup(t: TestTenant) {
  const sent: ProfileBuildJobData[] = [];
  return { app: appFor(t, { '/profile': createProfileRoutes({ queue: fakeQueue(sent) }) }), sent };
}

const approve = (app: ReturnType<typeof setup>['app'], version: number) =>
  app.request('/profile/approve', json({ version }));

const withResume = (t: TestTenant) =>
  upsertConnection(t.handle, {
    userId: t.userId,
    kind: 'resume',
    config: { text: 'Mara Quill resume text' },
  });

describe('POST /profile/build and GET /profile/build/status', () => {
  it('is 409 no_resume without a resume, and enqueues nothing', async () => {
    const t = await env.makeTenant();
    const { app, sent } = setup(t);
    const res = await app.request('/profile/build', { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_resume');
    expect(sent).toHaveLength(0);
  });

  it('a resume connection without extracted text is not a resume', async () => {
    const t = await env.makeTenant();
    await upsertConnection(t.handle, { userId: t.userId, kind: 'resume', config: { text: '' } });
    const res = await setup(t).app.request('/profile/build', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('202 with a job id, enqueues the job for this tenant and user; status is idle then running', async () => {
    const t = await env.makeTenant();
    await withResume(t);
    const { app, sent } = setup(t);
    expect(await (await app.request('/profile/build/status')).json()).toEqual({ state: 'idle' });
    const res = await app.request('/profile/build', { method: 'POST' });
    expect(res.status).toBe(202);
    const { job_id } = await res.json();
    expect(sent).toEqual([{ tenantId: t.id, userId: t.userId, buildId: job_id }]);
    expect(await (await app.request('/profile/build/status')).json()).toEqual({ state: 'running' });
  });

  it('a second request while one is running reuses the job', async () => {
    const t = await env.makeTenant();
    await withResume(t);
    const { app, sent } = setup(t);
    const a = await (await app.request('/profile/build', { method: 'POST' })).json();
    const b = await (await app.request('/profile/build', { method: 'POST' })).json();
    expect(b.job_id).toBe(a.job_id);
    expect(sent).toHaveLength(1);
  });

  it('status reports done with the version and failed with the reason', async () => {
    const t = await env.makeTenant();
    await withResume(t);
    const { app } = setup(t);
    const { job_id } = await (await app.request('/profile/build', { method: 'POST' })).json();
    await finishProfileBuild(t.handle, job_id, { state: 'done', version: 3 });
    expect(await (await app.request('/profile/build/status')).json()).toEqual({
      state: 'done',
      version: 3,
    });
    const failed = await startProfileBuild(t.handle, t.userId);
    await finishProfileBuild(t.handle, failed.id, {
      state: 'failed',
      reason: 'profile_build_invalid_output',
    });
    expect(await (await app.request('/profile/build/status')).json()).toEqual({
      state: 'failed',
      reason: 'profile_build_invalid_output',
    });
  });

  it('age alone never releases a running build: a live job keeps the reservation', async () => {
    const t = await env.makeTenant();
    await withResume(t);
    const sent: ProfileBuildJobData[] = [];
    const queue = fakeQueue(sent);
    const first = await requestProfileBuild(t.handle, t.userId, queue);
    const later = new Date(Date.now() + BUILD_STALE_MS + 1000);
    // Past the stale window, but the queue says the job is still queued or running.
    expect(await getBuildStatus(t.handle, t.userId, queue, later)).toEqual({ state: 'running' });
    expect(await requestProfileBuild(t.handle, t.userId, queue, later)).toBe(first);
    expect(sent).toHaveLength(1);
    const active = fakeQueue(sent, { [first]: 'active' });
    expect(await requestProfileBuild(t.handle, t.userId, active, later)).toBe(first);
    expect(sent).toHaveLength(1);
  });

  it.each(['completed', 'failed', 'cancelled', null] as const)(
    'a build past the stale window whose job is %s is released and replaced',
    async (jobState) => {
      const t = await env.makeTenant();
      await withResume(t);
      const sent: ProfileBuildJobData[] = [];
      const first = await requestProfileBuild(t.handle, t.userId, fakeQueue(sent));
      const later = new Date(Date.now() + BUILD_STALE_MS + 1000);
      const dead = fakeQueue(sent, { [first]: jobState });
      expect(await getBuildStatus(t.handle, t.userId, dead, later)).toEqual({
        state: 'failed',
        reason: 'profile_build_timeout',
      });
      const second = await requestProfileBuild(t.handle, t.userId, dead, later);
      expect(second).not.toBe(first);
      expect(sent.map((d) => d.buildId)).toEqual([first, second]);
      expect(await getBuildStatus(t.handle, t.userId, dead)).toEqual({ state: 'running' });
    },
  );

  it('a build younger than the stale window is never checked against the queue', async () => {
    const t = await env.makeTenant();
    await withResume(t);
    const first = await requestProfileBuild(t.handle, t.userId, fakeQueue());
    const dead = fakeQueue([], { [first]: 'failed' });
    expect(await requestProfileBuild(t.handle, t.userId, dead)).toBe(first);
  });

  it('parallel build requests reserve one build and enqueue one job', async () => {
    const t = await env.makeTenant();
    await withResume(t);
    const sent: ProfileBuildJobData[] = [];
    const queue = fakeQueue(sent);
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => requestProfileBuild(t.handle, t.userId, queue)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('an enqueue failure marks the build failed and surfaces as an error', async () => {
    const t = await env.makeTenant();
    await withResume(t);
    const app = appFor(t, {
      '/profile': createProfileRoutes({
        queue: {
          ...fakeQueue(),
          enqueueProfileBuild: async () => {
            throw new Error('queue down');
          },
        },
      }),
    });
    app.onError((_e, c) => c.json({ code: 'internal' }, 500));
    const res = await app.request('/profile/build', { method: 'POST' });
    expect(res.status).toBe(500);
    expect((await getLatestProfileBuild(t.handle, t.userId))?.state).toBe('failed');
  });
});

describe('GET and PUT /profile', () => {
  it('GET is 404 no_profile before any version', async () => {
    const t = await env.makeTenant();
    const res = await setup(t).app.request('/profile');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('no_profile');
  });

  it('GET returns the latest version with flags and pending_review', async () => {
    const t = await env.makeTenant();
    const doc = { ...baseDoc(), flags: [flag('partial_source')] };
    await insertProfileVersion(t.handle, { userId: t.userId, document: doc });
    const body = await (await setup(t).app.request('/profile')).json();
    expect(body).toMatchObject({
      version: 1,
      approved_version: null,
      approved_at: null,
      pending_review: true,
    });
    expect(body.flags).toHaveLength(1);
    expect(body.document.identity.full_name).toBe('Ada Example');
  });

  it('GET exposes built_from: empty for the default column, the sources once built', async () => {
    const t = await env.makeTenant();
    await insertProfileVersion(t.handle, { userId: t.userId, document: baseDoc() });
    expect((await (await setup(t).app.request('/profile')).json()).built_from).toEqual([]);
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: baseDoc(),
      builtFrom: ['resume', 'github'],
    });
    expect((await (await setup(t).app.request('/profile')).json()).built_from).toEqual([
      'resume',
      'github',
    ]);
  });

  it('PUT saves an edit as a new version, keeps the old one readable, and logs it', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    await insertProfileVersion(t.handle, { userId: t.userId, document: baseDoc() });
    const edited = baseDoc();
    edited.identity.headline = 'Staff engineer';
    const res = await app.request('/profile', json({ document: edited }, 'PUT'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2 });
    const body = await (await app.request('/profile')).json();
    expect(body.version).toBe(2);
    expect(body.document.identity.headline).toBe('Staff engineer');
    const v1 = await getProfileVersion(t.handle, t.userId, 1);
    expect((v1.document as ProfileDocument).identity.headline).toBe('Senior backend engineer');
    const log = (await activity.listByUser(t.handle, t.userId)).find(
      (a) => a.action === 'profile_edited',
    );
    expect(log?.detail).toEqual({ version: 2 });
  });

  it('PUT rejects an invalid document with 400 validation and issues, and an entry without sources', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const bad = baseDoc();
    bad.work_history[0]!.sources = [];
    bad.work_history[0]!.start_date = '2021-13';
    const res = await app.request('/profile', json({ document: bad }, 'PUT'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('validation');
    expect(body.issues.length).toBeGreaterThanOrEqual(2);
    expect(
      (
        await app.request('/profile', {
          method: 'PUT',
          body: 'not json',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    expect((await app.request('/profile')).status).toBe(404); // nothing was stored
  });
});

describe('POST /profile/approve', () => {
  it('is 404 without a profile', async () => {
    const t = await env.makeTenant();
    expect((await approve(setup(t).app, 1)).status).toBe(404);
  });

  it('requires the reviewed version in the body', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    await insertProfileVersion(t.handle, { userId: t.userId, document: baseDoc() });
    for (const body of [{}, { version: 'x' }, { version: 0 }, { version: 1.5 }]) {
      const res = await app.request('/profile/approve', json(body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('validation');
    }
    expect((await app.request('/profile/approve', { method: 'POST' })).status).toBe(400);
    expect((await getUserById(t.handle, t.userId)).approvedProfileVersion).toBeNull();
  });

  it('is 409 version_mismatch when a newer version exists than the one reviewed', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    await insertProfileVersion(t.handle, { userId: t.userId, document: baseDoc() });
    // A rebuild finishes after the page loaded version 1.
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: baseDoc(),
      builtFrom: ['resume'],
    });
    const stale = await approve(app, 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'version_mismatch', latest_version: 2 });
    expect((await getUserById(t.handle, t.userId)).approvedProfileVersion).toBeNull();
    expect((await approve(app, 3)).status).toBe(409); // a version that does not exist yet
    const ok = await approve(app, 2);
    expect(ok.status).toBe(200);
    expect((await ok.json()).approved_version).toBe(2);
  });

  it('refused with an unresolved date conflict, allowed after the user resolves it by editing', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const conflict = flag('date_conflict', {
      path: 'work_history.1',
      value: 'Globex',
      section: 'work_history',
    });
    const unsupported = flag('unsupported_entry', { section: 'work_history', value: 'Initech' });
    const partial = flag('partial_source', { sources: ['linkedin'] });
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: { ...baseDoc(), flags: [conflict, unsupported, partial] },
    });

    const refused = await approve(app, 1);
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.code).toBe('unresolved_flags');
    expect(body.flags.map((f: ProfileFlag) => f.kind).sort()).toEqual([
      'date_conflict',
      'unsupported_entry',
    ]);
    expect((await getUserById(t.handle, t.userId)).approvedProfileVersion).toBeNull();

    // Resolving means removing the blocking flags; the partial flag never blocks.
    const edited = { ...baseDoc(), flags: [partial] };
    expect((await app.request('/profile', json({ document: edited }, 'PUT'))).status).toBe(200);
    const ok = await approve(app, 2);
    expect(ok.status).toBe(200);
    const approved = await ok.json();
    expect(approved.approved_version).toBe(2);
    expect(new Date(approved.approved_at).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const user = await getUserById(t.handle, t.userId);
    expect(user.approvedProfileVersion).toBe(2);
    expect(user.approvedProfileAt?.toISOString()).toBe(approved.approved_at);
    const view = await (await app.request('/profile')).json();
    expect(view).toMatchObject({
      approved_version: 2,
      approved_at: approved.approved_at,
      pending_review: false,
    });
    const log = (await activity.listByUser(t.handle, t.userId)).find(
      (a) => a.action === 'profile_approved',
    );
    expect(log).toMatchObject({ actor: 'user', detail: { version: 2 } });
  });

  it('setting resolved: true on a blocking flag does not unblock approval', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    const unsupported = flag('unsupported_entry', { section: 'work_history', value: 'Initech' });
    const conflict = flag('date_conflict', { path: 'work_history.0' });
    const edited = {
      ...baseDoc(),
      flags: [
        { ...unsupported, resolved: true },
        { ...conflict, resolved: true },
      ],
    };
    expect((await app.request('/profile', json({ document: edited }, 'PUT'))).status).toBe(200);
    const res = await approve(app, 1);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('unresolved_flags');
    expect(body.flags.map((f: ProfileFlag) => f.kind).sort()).toEqual([
      'date_conflict',
      'unsupported_entry',
    ]);
    expect((await getUserById(t.handle, t.userId)).approvedProfileVersion).toBeNull();
  });

  it('partial_source flags never block, resolved or not', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: { ...baseDoc(), flags: [flag('partial_source'), flag('missing_info')] },
    });
    expect((await approve(app, 1)).status).toBe(200);
  });

  it('approving again without changes keeps the original approval time', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    await insertProfileVersion(t.handle, { userId: t.userId, document: baseDoc() });
    const first = await (await approve(app, 1)).json();
    const second = await (await approve(app, 1)).json();
    expect(second).toEqual(first);
  });

  it('a rebuild after approval is pending review while the approved version stays in use', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    await insertProfileVersion(t.handle, { userId: t.userId, document: baseDoc() });
    await approve(app, 1);
    // the worker inserts a rebuilt version
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: baseDoc(),
      builtFrom: ['resume'],
    });
    const view = await (await app.request('/profile')).json();
    expect(view).toMatchObject({ version: 2, approved_version: 1, pending_review: true });
    expect(await requireApprovedProfile(t.handle, t.userId)).toBe(1);
    // approving the new version moves the pointer
    const r = await (await approve(app, 2)).json();
    expect(r.approved_version).toBe(2);
    expect(await requireApprovedProfile(t.handle, t.userId)).toBe(2);
  });

  it('an edit after approval also awaits re-approval', async () => {
    const t = await env.makeTenant();
    const { app } = setup(t);
    await insertProfileVersion(t.handle, { userId: t.userId, document: baseDoc() });
    await approve(app, 1);
    await app.request('/profile', json({ document: baseDoc() }, 'PUT'));
    const view = await (await app.request('/profile')).json();
    expect(view).toMatchObject({ version: 2, approved_version: 1, pending_review: true });
  });
});
