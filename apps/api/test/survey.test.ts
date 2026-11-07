import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, getProfileVersion, getUserById, insertProfileVersion } from '@wma/db';
import { profileDocumentSchema, type ProfileDocument } from '@wma/shared';
import fixture from '../../../packages/shared/test/fixtures/profile.full.json';
import { surveyRoutes } from '../src/routes/survey';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const app = (t: TestTenant) => appFor(t, { '/survey': surveyRoutes });
const answers = (over: Record<string, unknown> = {}) => ({
  target_roles: ['Staff Backend Engineer'],
  salary_floor: 95000,
  work_life_balance: 'Predictable hours',
  family_constraints: null,
  willing_to_relocate: false,
  career_direction: 'Tech lead',
  daily_target: 8,
  locations: ['Lisbon', 'Remote EU'],
  remote: 'hybrid',
  ...over,
});

describe('survey', () => {
  it('GET is {answers: null} before the survey is completed', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/survey');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answers: null });
  });

  it('completed: creates version 1 with an empty document and the answers, and GET returns them', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    const res = await a.request('/survey', json({ answers: answers() }, 'PUT'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1 });
    const doc = (await getProfileVersion(t.handle, t.userId, 1)).document as ProfileDocument;
    expect(doc.work_history).toEqual([]);
    expect(doc.identity.full_name).toBe('Mara Quill');
    expect(doc.contact.email).toBe(t.email);
    expect(doc.survey).toMatchObject({
      target_roles: ['Staff Backend Engineer'],
      salary_floor: 95000,
      daily_target: 8,
    });
    expect(doc.preferences).toEqual({
      target_titles: ['Staff Backend Engineer'],
      locations: ['Lisbon', 'Remote EU'],
      remote: 'hybrid',
    });
    expect(profileDocumentSchema.safeParse(doc).success).toBe(true);
    expect((await getUserById(t.handle, t.userId)).dailyTarget).toBe(8);
    const got = await (await a.request('/survey')).json();
    expect(got.answers).toMatchObject({
      target_roles: ['Staff Backend Engineer'],
      salary_floor: 95000,
      daily_target: 8,
      remote: 'hybrid',
    });
  });

  it('missing required field: rejected with the field named, nothing stored', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    for (const [field, patch] of [
      ['target_roles', { target_roles: [] }],
      ['salary_floor', { salary_floor: null }],
    ] as const) {
      const res = await a.request('/survey', json({ answers: answers(patch) }, 'PUT'));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('validation');
      expect(body.issues.some((i: { path: unknown[] }) => i.path.includes(field))).toBe(true);
    }
    const missing = answers();
    delete (missing as Record<string, unknown>).salary_floor;
    const res = await a.request('/survey', json({ answers: missing }, 'PUT'));
    expect(res.status).toBe(400);
    expect(await getUserById(t.handle, t.userId)).toBeTruthy();
    expect(await (await a.request('/survey')).json()).toEqual({ answers: null });
  });

  it('default target: leaving daily_target unset stores 12', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    const body = answers();
    delete (body as Record<string, unknown>).daily_target;
    expect((await a.request('/survey', json({ answers: body }, 'PUT'))).status).toBe(200);
    const doc = (await getProfileVersion(t.handle, t.userId, 1)).document as ProfileDocument;
    expect(doc.survey.daily_target).toBe(12);
    expect((await getUserById(t.handle, t.userId)).dailyTarget).toBe(12);
  });

  it('out-of-range target: 0, 31 and a fraction are rejected; 1 and 30 are accepted', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    for (const bad of [0, 31, 12.5, -3]) {
      const res = await a.request(
        '/survey',
        json({ answers: answers({ daily_target: bad }) }, 'PUT'),
      );
      expect(res.status, String(bad)).toBe(400);
      expect(
        (await res.json()).issues.some((i: { path: unknown[] }) => i.path.includes('daily_target')),
      ).toBe(true);
    }
    expect(
      (await a.request('/survey', json({ answers: answers({ daily_target: 1 }) }, 'PUT'))).status,
    ).toBe(200);
    expect(
      (await a.request('/survey', json({ answers: answers({ daily_target: 30 }) }, 'PUT'))).status,
    ).toBe(200);
  });

  it('revise: a change makes a new version, keeps built sections, and is written to the activity log', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: profileDocumentSchema.parse(structuredClone(fixture)),
    });
    const first = await (await a.request('/survey', json({ answers: answers() }, 'PUT'))).json();
    expect(first.version).toBe(2);
    const second = await (
      await a.request('/survey', json({ answers: answers({ salary_floor: 110000 }) }, 'PUT'))
    ).json();
    expect(second.version).toBe(3);
    const v3 = (await getProfileVersion(t.handle, t.userId, 3)).document as ProfileDocument;
    expect(v3.survey.salary_floor).toBe(110000);
    expect(v3.work_history.map((w) => w.employer)).toEqual(['Acme Corp', 'Globex']);
    const v2 = (await getProfileVersion(t.handle, t.userId, 2)).document as ProfileDocument;
    expect(v2.survey.salary_floor).toBe(95000);
    const actions = (await activity.listByUser(t.handle, t.userId)).map((e) => e.action);
    expect(actions.filter((x) => x === 'survey_revised')).toHaveLength(2);
  });

  it('invalid JSON is a 400 validation error', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/survey', {
      method: 'PUT',
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('validation');
  });
});
