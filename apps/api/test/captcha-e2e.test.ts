import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApplication, listCaptchaRequestsForApplication } from '@wma/db';
import { FakeLlm } from '@wma/llm';
import { runSubmission } from '../../worker/src/submission/job';
import {
  FakeAdapter,
  FakeCaptcha,
  approveProfile,
  makeDeps,
  seedApplication,
  setupSubmissionEnv,
  type SubmissionEnv,
} from '../../worker/test/submission/support';
import type { AppEnv } from '../src/middleware/session';
import { applicationsRoutes } from '../src/routes/applications';
import { appFor } from './support';
import { captchaRoutes } from '../src/routes/captcha';

let env: SubmissionEnv;
beforeAll(async () => {
  env = await setupSubmissionEnv();
});
afterAll(async () => {
  await env.cleanup();
});

describe('task 8.2: both solvers fail, the user answers through the reply page', () => {
  it('ends applied and the request shows resolved_by human', async () => {
    const t = await env.makeTenant();
    await approveProfile(t);
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    const challenge = new FakeCaptcha('ABC123');
    adapter.captchas = [challenge];
    const deps = makeDeps(env.db, { adapter, llm: new FakeLlm([{ answer: 'WRONG' }]) });

    const api = new Hono<AppEnv>();
    api.use('*', async (c, next) => {
      c.set('db', env.db);
      c.set('now', () => deps.clock.now());
      await next();
    });
    api.route('/captcha', captchaRoutes);

    const replies: number[] = [];
    deps.clock.onSleep = async () => {
      const mail = deps.sender.sent[0];
      if (!mail || replies.length) return;
      const token = /\/captcha\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
      const page = await api.request(`/captcha/${token}`);
      expect(page.status).toBe(200);
      const res = await api.request(`/captcha/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'answer=ABC123',
      });
      replies.push(res.status);
    };

    const out = await runSubmission(deps, env.db, {
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
    expect(out).toMatchObject({ outcome: 'applied', source: 'page' });
    expect(replies).toEqual([200]);
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({ status: 'applied' });
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({
      resolvedBy: 'human',
      humanAnswer: 'ABC123',
      attempts: { agent1: 3, agent2: 3, human: 1 },
    });
    expect(challenge.entered.at(-1)).toBe('ABC123');
  });
});

describe('failure details never carry a password', () => {
  it('a password inside a thrown browser error is absent from the detail endpoint', async () => {
    const t = await env.makeTenant();
    await approveProfile(t);
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    let typed = '';
    adapter.signUp = async (_page, account) => {
      typed = account.password;
      throw new Error(
        `locator.fill: Timeout 30000ms exceeded.\n  fill("${account.password}") navigating to https://boards.greenhouse.io/verify?token=${account.password}`,
      );
    };
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, {
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
    expect(out).toEqual({ outcome: 'pending', reason: 'browser-error' });
    expect(typed).toHaveLength(24);

    const api = appFor(t as never, { '/applications': applicationsRoutes });
    const res = await api.request(`/applications/${s.application.id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(typed);
    expect(body).not.toContain('token=');
    expect(body).toContain('browser-error');
  });
});
