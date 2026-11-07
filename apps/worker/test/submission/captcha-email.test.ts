import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLlm } from '@wma/llm';
import { InMemoryOutgoingStore, moneyGuard, type ContentGuard } from '@wma/shared';
import { captchaEmail } from '../../src/submission/captcha/email';
import { runSubmission } from '../../src/submission/job';
import {
  FakeAdapter,
  FakeCaptcha,
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

/** Task 6.4: the CAPTCHA request email is an immediate send through the guarded sendEmail. */
describe('CAPTCHA request email', () => {
  it('is sent through the guarded sender within the job run, not deferred to the digest', async () => {
    const t = await env.makeTenant();
    await approveProfile(t);
    const s = await seedApplication(t);
    const captcha = new FakeCaptcha('ABC123');
    const adapter = new FakeAdapter();
    adapter.captchas = [captcha];
    const deps = makeDeps(env.db, { adapter, llm: new FakeLlm([() => ({ answer: 'WRONG' })]) });

    const store = new InMemoryOutgoingStore();
    let guardChecks = 0;
    const spy: ContentGuard = {
      name: 'spy',
      check: () => {
        guardChecks++;
        return { ok: true };
      },
    };
    deps.sendMail = () => ({ sender: deps.sender, guards: [spy, moneyGuard], store });

    // The user is waiting on the first poll of the human stage: the email must already be out.
    const sentAtFirstPoll: number[] = [];
    deps.clock.onSleep = async () => {
      sentAtFirstPoll.push(deps.sender.sent.length);
      const open = await env.owner.query<{ id: string }>(
        `select id from captcha_requests where user_id = $1 and stage = 'human' and human_answer is null`,
        [t.userId],
      );
      for (const row of open.rows) {
        await env.owner.query('update captcha_requests set human_answer = $2 where id = $1', [
          row.id,
          'ABC123',
        ]);
      }
    };

    const out = await runSubmission(deps, env.db, {
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
    expect(out.outcome).toBe('applied');

    // Sent inside the run, before the first wait for the user's reply.
    expect(sentAtFirstPoll[0]).toBe(1);
    expect(deps.sender.sent).toHaveLength(1);
    expect(deps.sender.sent[0]!.to).toBe(t.email);
    // It went through sendEmail: the guards ran on it and the attempt was stored, as sent.
    expect(guardChecks).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ blocked: false, to: t.email });
    expect(store.rows[0]!.sentAt).toBeInstanceOf(Date);
    // Nothing was handed to the digest or any queue for later.
    expect(store.rows.some((r) => r.kind === 'digest')).toBe(false);
    expect(deps.followUps.every((f) => f.data.applicationId === s.application.id)).toBe(true);
  });
});

describe('CAPTCHA request email content', () => {
  const png = Buffer.from('x');
  it('scrubs money text in the company name and job title before any guard sees it', async () => {
    const mail = captchaEmail({
      companyName: 'Acme $150k Club',
      jobTitle: 'Engineer, equity track',
      link: 'https://x.test/captcha/t',
      image: png,
    });
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(
        await moneyGuard.check({
          userId: 'u',
          to: 'a',
          subject: mail.subject,
          text: part,
          html: part,
        }),
      ).toEqual({ ok: true });
    }
    expect(mail.subject).toContain('[omitted]');
  });

  it('is stored as a captcha_request with its application and a request+attempt delivery key', async () => {
    const t = await env.makeTenant();
    await approveProfile(t);
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.captchas = [new FakeCaptcha('ABC123')];
    const deps = makeDeps(env.db, { adapter, llm: new FakeLlm([() => ({ answer: 'WRONG' })]) });
    const store = new InMemoryOutgoingStore();
    deps.sendMail = () => ({ sender: deps.sender, guards: [moneyGuard], store });
    deps.clock.onSleep = async () => {
      await env.owner.query(
        `update captcha_requests set human_answer = 'ABC123' where user_id = $1 and stage = 'human' and human_answer is null`,
        [t.userId],
      );
    };
    await runSubmission(deps, env.db, {
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
    expect(store.rows[0]).toMatchObject({
      kind: 'captcha_request',
      applicationId: s.application.id,
    });
    expect(store.rows[0]!.deliveryKey).toMatch(/^captcha_request:[0-9a-f-]{36}:0$/);
  });

  it('a blocked challenge email counts as email_failed (no wait for the user)', async () => {
    const t = await env.makeTenant();
    await approveProfile(t);
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.captchas = [new FakeCaptcha('ABC123')];
    const deps = makeDeps(env.db, { adapter, llm: new FakeLlm([() => ({ answer: 'WRONG' })]) });
    const block: ContentGuard = { name: 'always', check: () => ({ ok: false, reason: 'no' }) };
    deps.sendMail = () => ({
      sender: deps.sender,
      guards: [block],
      store: new InMemoryOutgoingStore(),
    });
    let slept = 0;
    deps.clock.onSleep = async () => {
      slept++;
    };
    const out = await runSubmission(deps, env.db, {
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
    expect(out.outcome).not.toBe('applied');
    expect(slept).toBe(0);
    expect(deps.sender.sent).toHaveLength(0);
    const log = await env.owner.query(
      `select detail from activity_log where user_id = $1 and action = 'captcha-timeout'`,
      [t.userId],
    );
    expect(log.rows[0]?.detail).toMatchObject({ detail: 'email_failed' });
  });
});
