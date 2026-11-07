import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, getApplication, getFile, listCaptchaRequestsForApplication } from '@wma/db';
import { FakeLlm } from '@wma/llm';
import { startTrace } from '../../src/submission/adapters/common';
import { runSubmission } from '../../src/submission/job';
import { SubmissionFailure } from '../../src/submission/failure';
import {
  FakeAdapter,
  FakeCaptcha,
  FrameCaptcha,
  approveProfile,
  makeDeps,
  seedApplication,
  setupSubmissionEnv,
  type SubmissionEnv,
} from './support';

let env: SubmissionEnv;
beforeAll(async () => {
  env = await setupSubmissionEnv();
});
afterAll(async () => {
  await env.cleanup();
});

async function tenant() {
  const t = await env.makeTenant();
  await approveProfile(t);
  return t;
}
const data = (t: { id: string; userId: string }, applicationId: string) => ({
  tenantId: t.id,
  userId: t.userId,
  applicationId,
});

describe('wave 5: what the generic page layer reports to the job', () => {
  it('form-rejected: pending with the error texts and a screenshot, no second submit', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.beforeSubmit = () => {
      throw new SubmissionFailure('form-rejected', {
        errors: ['Email: Enter a valid email address'],
      });
    };
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'form-rejected' });
    expect(adapter.submits).toBe(0);
    expect(deps.browser.pages[0]!.screenshots).toBe(1);
    const row = await getApplication(t.handle, s.application.id);
    expect(row).toMatchObject({
      status: 'pending',
      pendingReason: 'form-rejected',
      attemptCount: 1,
    });
    const entry = (await activity.listByApplication(t.handle, s.application.id)).find(
      (e) => e.action === 'form-rejected',
    );
    expect(entry?.detail).toMatchObject({
      errors: ['Email: Enter a valid email address'],
      attempt: 1,
      screenshot: `tenants/${t.id}/applications/${s.application.id}/failure-1.png`,
    });
    expect(
      await getFile(t.handle, `tenants/${t.id}/applications/${s.application.id}/failure-1.png`),
    ).not.toBeNull();
  });

  it('records a form notice (an application limit) and still submits', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    (adapter as FakeAdapter & { notices: () => Promise<unknown[]> }).notices = async () => [
      { kind: 'application-limit', max: 5, days: 180 },
    ];
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    const log = (await activity.listByApplication(t.handle, s.application.id)).reverse();
    expect(log.map((e) => e.action)).toEqual([
      'submission-started',
      'tailored',
      'form-notice',
      'filled',
      'submitting',
      'submitted',
    ]);
    expect(log[2]!.detail).toEqual({ kind: 'application-limit', max: 5, days: 180 });
  });

  it('an iframe challenge goes straight to the human stage: no solver attempts, a full-page screenshot, cleared externally', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    const frame = new FrameCaptcha();
    adapter.captchas = [frame];
    const llm = new FakeLlm([{ answer: 'WRONG' }]);
    const deps = makeDeps(env.db, { adapter, llm });
    deps.clock.onSleep = async () => {
      // The user opens the page and solves the challenge there; the emailed reply is only the nudge.
      frame.solved = true;
      await env.owner.query(
        `update captcha_requests set human_answer = 'done'
          where user_id = $1 and stage = 'human' and human_answer is null and resolved_at is null`,
        [t.userId],
      );
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(llm.calls).toHaveLength(0);
    // The handle does not type into the frame: the answer reached it and did nothing.
    expect(frame.entered).toEqual(['done']);
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({
      resolvedBy: 'human',
      attempts: { agent1: 0, agent2: 0, human: 1 },
    });
    expect(deps.sender.sent).toHaveLength(1);
    expect(deps.sender.sent[0]!.attachments![0]).toMatchObject({ contentType: 'image/png' });
    const trail = (await activity.listByApplication(t.handle, s.application.id))
      .reverse()
      .map((e) => e.action);
    expect(trail).toContain('captcha-stage');
    expect(trail).toContain('captcha-human-requested');
    expect(trail.filter((a) => a === 'captcha-stage')).toHaveLength(1);
  });

  it('an iframe challenge is not cleared by a typed answer alone: the human attempts run out', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    const frame = new FrameCaptcha();
    adapter.captchas = [frame];
    const llm = new FakeLlm([{ answer: 'WRONG' }]);
    const deps = makeDeps(env.db, { adapter, llm });
    deps.clock.onSleep = async () => {
      await env.owner.query(
        `update captcha_requests set human_answer = 'ABC123'
          where user_id = $1 and stage = 'human' and resolved_at is null`,
        [t.userId],
      );
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'captcha-timeout' });
    expect(llm.calls).toHaveLength(0);
    expect(frame.entered.length).toBeGreaterThan(0);
    expect(frame.entered.every((a) => a === 'ABC123')).toBe(true);
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req?.resolvedBy).toBeNull();
  });
});

describe('rules 36 and 38: the submit trace and the second click', () => {
  const trace = (hosts: string[]) => ({
    posts: hosts.map((host) => ({ host, path: '/x', status: 200 })),
    console: ['boom'],
    screenshot: Buffer.from('png'),
  });
  async function runWithCaptcha(hosts: string[]) {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.confirmedAfterSubmit = false;
    adapter.traces = [trace(hosts)];
    adapter.captchas = [null, new FakeCaptcha('ABC123')];
    const deps = makeDeps(env.db, { adapter, llm: new FakeLlm([{ answer: 'ABC123' }]) });
    await runSubmission(deps, env.db, data(t, s.application.id));
    const log = await activity.listByApplication(t.handle, s.application.id);
    return { t, s, adapter, log };
  }

  it('writes one submit-trace entry per click and stores the screenshot', async () => {
    const { t, s, adapter, log } = await runWithCaptcha(['www.google.com']);
    const entries = log.filter((e) => e.action === 'submit-trace');
    expect(adapter.submits).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.detail).toMatchObject({
      posts: [{ host: 'www.google.com', path: '/x', status: 200 }],
      console: ['boom'],
      screenshot: `tenants/${t.id}/applications/${s.application.id}/submit-1.png`,
    });
    expect(
      await getFile(t.handle, `tenants/${t.id}/applications/${s.application.id}/submit-1.png`),
    ).not.toBeNull();
  });

  it('skips the second click when the first posted to the vendor', async () => {
    const { adapter, log } = await runWithCaptcha(['api.ashbyhq.com']);
    expect(adapter.submits).toBe(1);
    const skipped = log.find((e) => e.action === 'submit-skipped');
    expect(skipped?.detail).toMatchObject({ reason: 'vendor-post-seen' });
  });

  it('clicks again when the only POSTs went to a CAPTCHA provider or Google', async () => {
    const { adapter, log } = await runWithCaptcha(['www.google.com', 'hcaptcha.com']);
    expect(adapter.submits).toBe(2);
    expect(log.some((e) => e.action === 'submit-skipped')).toBe(false);
  });
});

describe('rule 40: the emailed code after submit', () => {
  const mail = (
    company: string,
    clock: Date,
    body = 'Copy and paste this code: 48151623 After you enter the code, resubmit your application.',
  ) => ({
    from: 'no-reply@us.greenhouse-mail.io',
    subject: `Security code for your application to ${company}`,
    text: body,
    receivedAt: new Date(clock.getTime() + 1000),
  });

  it('reads the newest code from Gmail, types it, clicks submit again and logs only the source', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.codePrompts = 1;
    const deps = makeDeps(env.db, { adapter });
    deps.gmailBox.add({
      ...mail(s.companyName, deps.clock.now(), 'Code: 11111111'),
      receivedAt: new Date(deps.clock.now().getTime() + 500),
    });
    deps.gmailBox.add(mail(s.companyName, deps.clock.now()));
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'applied', source: 'page', prior: false });
    expect(adapter.submits).toBe(2);
    expect(deps.browser.pages[0]!.typed.map((x) => x.value)).toEqual(['48151623']);
    const log = await activity.listByApplication(t.handle, s.application.id);
    const entry = log.find((e) => e.action === 'email-verification');
    expect(entry?.detail).toEqual({ source: 'code' });
    expect(JSON.stringify(log)).not.toContain('48151623');
  });

  it('no code within the cap is verification-timeout', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.codePrompts = 1;
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'verification-timeout' });
    expect(adapter.submits).toBe(1);
  });
});

describe('rule 41: the page is re-checked on every tick of the confirmation wait', () => {
  it('a page that turns confirmed 20 s after the click resolves applied from the page, without mail', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.confirmedAfterSubmit = false;
    const deps = makeDeps(env.db, { adapter });
    let clickedAt = 0;
    const submit = adapter.submit.bind(adapter);
    adapter.submit = async () => {
      clickedAt = deps.clock.now().getTime();
      return submit();
    };
    adapter.confirmed = async () =>
      clickedAt > 0 && deps.clock.now().getTime() - clickedAt >= 20_000;
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'applied', source: 'page', prior: false });
    // Found on the third tick after 20 s, long before the 600 s mail cap.
    expect(deps.clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(60_000);
  });

  it('a validation error shown during the wait is form-rejected with the error texts', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.confirmedAfterSubmit = false;
    const deps = makeDeps(env.db, { adapter });
    let clickedAt = 0;
    const submit = adapter.submit.bind(adapter);
    adapter.submit = async () => {
      clickedAt = deps.clock.now().getTime();
      return submit();
    };
    adapter.validationErrors = async () =>
      clickedAt > 0 && deps.clock.now().getTime() - clickedAt >= 12_000
        ? ['Your form needs corrections: Missing entry for required field: Legal Name']
        : [];
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'form-rejected' });
    const entry = (await activity.listByApplication(t.handle, s.application.id)).find(
      (e) => e.action === 'form-rejected',
    );
    expect(entry?.detail).toMatchObject({
      errors: ['Your form needs corrections: Missing entry for required field: Legal Name'],
    });
  });
});

describe('rule 42: the submit trace path', () => {
  it('keeps op/operationName for a graphql path and drops every other query string', async () => {
    const listeners = new Map<string, (arg: unknown) => void>();
    const page = {
      on: (ev: string, fn: (arg: unknown) => void) => void listeners.set(ev, fn),
      off: () => {},
      screenshot: async () => Buffer.from('png'),
    };
    const post = (url: string) =>
      listeners.get('request')!({ method: () => 'POST', url: () => url });
    const tracer = startTrace(page as never);
    post('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitMultipleFormsAction');
    post('https://x.test/graphql?operationName=Submit&token=abc');
    post('https://x.test/graphql?token=abc');
    post('https://x.test/api/apply?op=Nope&email=a@b.c');
    const trace = await tracer.finish();
    expect(trace.posts.map((p) => p.path)).toEqual([
      '/api/non-user-graphql?op=ApiSubmitMultipleFormsAction',
      '/graphql?operationName=Submit',
      '/graphql',
      '/api/apply',
    ]);
  });
});
