import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  extendHumanReservation,
  getApplication,
  getFile,
  listCaptchaRequestsForApplication,
} from '@wma/db';
import { FakeLlm } from '@wma/llm';
import { runSubmission } from '../../src/submission/job';
import {
  FakeAdapter,
  FakeCaptcha,
  FakeClock,
  approveProfile,
  makeDeps,
  seedApplication,
  setupSubmissionEnv,
  type SubmissionEnv,
  type TestDeps,
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
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenIn = (text: string) => /\/captcha\/([A-Za-z0-9_-]+)/.exec(text)![1]!;

/** An LLM whose n-th answer (1-based, across both solvers) comes from `answers`; then wrong. */
function llmAnswering(...answers: string[]) {
  let n = 0;
  return new FakeLlm([() => ({ answer: answers[n++] ?? 'WRONG' })]);
}

/** Plays the user: answers the open human-stage request with the nth entry of `replies`. */
function userReplies(env: SubmissionEnv, deps: TestDeps, userId: string, replies: string[]) {
  deps.clock.onSleep = async () => {
    const open = await env.owner.query<{ id: string }>(
      `select id from captcha_requests
        where user_id = $1 and stage = 'human' and human_answer is null
          and resolved_at is null and expired_at is null`,
      [userId],
    );
    for (const row of open.rows) {
      const reply = replies[deps.sender.sent.length - 1];
      if (reply !== undefined) {
        await env.owner.query('update captcha_requests set human_answer = $2 where id = $1', [
          row.id,
          reply,
        ]);
      }
    }
  };
}

async function setup(captcha: FakeCaptcha, llm: FakeLlm) {
  const t = await tenant();
  const s = await seedApplication(t);
  const adapter = new FakeAdapter();
  adapter.captchas = [captcha];
  const deps = makeDeps(env.db, { adapter, llm });
  return { t, s, deps, adapter };
}

describe('rules 12 and 13: the solver chain', () => {
  it('detects the challenge, stores the image and records it at stage agent1', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering('ABC123'));
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({ stage: 'agent1', resolvedBy: 'agent1' });
    expect(req!.imageRef).toBe(`tenants/${t.id}/applications/${s.application.id}/captcha-1.png`);
    expect(await getFile(t.handle, req!.imageRef!)).not.toBeNull();
    const names = (await activity.listByApplication(t.handle, s.application.id))
      .reverse()
      .map((e) => e.action);
    expect(names).toEqual([
      'submission-started',
      'tailored',
      'filled',
      'captcha-detected',
      'captcha-resolved',
      'submitting',
      'submitted',
    ]);
  });

  it('solved on the second attempt of stage one', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const llm = llmAnswering('WRONG', 'ABC123');
    const { t, s, deps } = await setup(captcha, llm);
    expect((await runSubmission(deps, env.db, data(t, s.application.id))).outcome).toBe('applied');
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({
      resolvedBy: 'agent1',
      attempts: { agent1: 2, agent2: 0, human: 0 },
    });
    expect(llm.calls.map((c) => c.prompt)).toEqual(['solve-captcha-a/v1', 'solve-captcha-a/v1']);
    expect(llm.calls[0]!.images?.[0]).toMatchObject({ mediaType: 'image/png' });
    expect(deps.sender.sent).toHaveLength(0);
    const resolved = (await activity.listByApplication(t.handle, s.application.id)).find(
      (e) => e.action === 'captcha-resolved',
    )!;
    expect(resolved.detail).toMatchObject({
      resolved_by: 'agent1',
      attempts: { agent1: 2, agent2: 0, human: 0 },
    });
  });

  it('stage one exhausted hands over to an independent second solver', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const llm = llmAnswering('x1', 'x2', 'x3', 'ABC123');
    const { t, s, deps } = await setup(captcha, llm);
    expect((await runSubmission(deps, env.db, data(t, s.application.id))).outcome).toBe('applied');
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({
      resolvedBy: 'agent2',
      stage: 'agent2',
      attempts: { agent1: 3, agent2: 1, human: 0 },
    });
    expect(llm.calls.map((c) => c.prompt)).toEqual([
      'solve-captcha-a/v1',
      'solve-captcha-a/v1',
      'solve-captcha-a/v1',
      'solve-captcha-b/v1',
    ]);
    // Different instructions, and each call carries only its own image and a fixed request.
    expect(llm.calls[3]!.system).not.toBe(llm.calls[0]!.system);
    expect(llm.calls[3]!.user).toBe(llm.calls[0]!.user);
    expect(deps.sender.sent).toHaveLength(0);
  });

  it('a malformed model reply counts as a failed attempt', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const llm = new FakeLlm([{ nope: 1 }, { answer: 'ABC123' }]);
    const { t, s, deps } = await setup(captcha, llm);
    expect((await runSubmission(deps, env.db, data(t, s.application.id))).outcome).toBe('applied');
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req!.attempts).toMatchObject({ agent1: 2 });
  });
});

describe('rule 13: the human stage', () => {
  it('emails the user the image and a one-use link, stores only the token hash, and applies the reply', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering());
    userReplies(env, deps, t.userId, ['ABC123']);
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');

    expect(deps.sender.sent).toHaveLength(1);
    const mail = deps.sender.sent[0]!;
    expect(mail.to).toBe(t.email);
    expect(mail.subject).toContain('Acme');
    expect(mail.subject).toContain(s.job.title);
    expect(mail.html).toContain('cid:captcha');
    expect(mail.attachments).toEqual([
      expect.objectContaining({ contentType: 'image/png', contentId: 'captcha' }),
    ]);
    expect(mail.attachments![0]!.content.length).toBeGreaterThan(0);
    const token = tokenIn(mail.text);
    expect(mail.text).toContain(`https://app.example.test/captcha/${token}`);
    expect(mail.html).toContain(`https://app.example.test/captcha/${token}`);

    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({
      resolvedBy: 'human',
      attempts: { agent1: 3, agent2: 3, human: 1 },
      humanAnswer: 'ABC123',
    });
    expect(req!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(req)).not.toContain(token);
    // The window is stamped by the database clock when the send is confirmed.
    expect(Math.abs(req!.expiresAt!.getTime() - (Date.now() + 900_000))).toBeLessThan(60_000);
    expect(new Set(deps.clock.sleeps)).toEqual(new Set([5000]));
    expect(captcha.entered.at(-1)).toBe('ABC123');
    const log = JSON.stringify(await activity.listByApplication(t.handle, s.application.id));
    expect(log).not.toContain(token);
  });

  it('re-sends with a fresh image and token after a wrong answer, inside the same window', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering());
    userReplies(env, deps, t.userId, ['WRONG1', 'ABC123']);
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(deps.sender.sent).toHaveLength(2);
    const [first, second] = deps.sender.sent.map((m) => tokenIn(m.text));
    expect(first).not.toBe(second);
    expect(
      deps.sender.sent[0]!.attachments![0]!.content.equals(
        deps.sender.sent[1]!.attachments![0]!.content,
      ),
    ).toBe(false);
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({ resolvedBy: 'human', attempts: { human: 2 } });
    expect(req!.tokenHash).toBe(sha256(second!));
    expect(req!.tokenHash).not.toBe(sha256(first!));
    expect(captcha.entered.slice(-2)).toEqual(['WRONG1', 'ABC123']);
  });

  it('gives up after three wrong human answers', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering());
    userReplies(env, deps, t.userId, ['A', 'B', 'C']);
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'captcha-timeout' });
    expect(deps.sender.sent).toHaveLength(3);
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req!.attempts).toMatchObject({ human: 3 });
    expect(req!.expiredAt).not.toBeNull();
    expect(deps.adapter.submits).toBe(0);
  });
});

describe('rule 13: timeout', () => {
  it('closes the context, expires the request and parks the application after 900 s', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering());
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'captcha-timeout' });
    expect(deps.clock.sleeps.reduce((a, b) => a + b, 0)).toBe(900_000);
    expect(deps.sender.sent).toHaveLength(1);
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({ resolvedAt: null, humanAnswer: null });
    expect(req!.expiredAt).not.toBeNull();
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({
      status: 'pending',
      pendingReason: 'captcha-timeout',
      attemptCount: 1,
    });
    expect(deps.browser.open).toBe(0);
    const log = await activity.listByApplication(t.handle, s.application.id);
    expect(log.map((e) => e.action)).toContain('captcha-timeout');
    expect(deps.adapter.submits).toBe(0);
  });

  it('a send failure ends the request as a timeout instead of waiting', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering());
    deps.sender.send = async () => {
      throw new Error('gmail down');
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'captcha-timeout' });
    expect(deps.clock.sleeps).toHaveLength(0);
  });
});

describe('rule 15: one open human request per user', () => {
  it('two concurrent challenges for one user send one email and park the other', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const b = await seedApplication(t);
    const clock = new FakeClock();
    const adapterA = new FakeAdapter();
    const adapterB = new FakeAdapter();
    adapterA.captchas = [new FakeCaptcha('ABC123')];
    adapterB.captchas = [new FakeCaptcha('ABC123')];
    const depsA = makeDeps(env.db, { adapter: adapterA, clock, llm: llmAnswering() });
    const depsB = makeDeps(env.db, { adapter: adapterB, clock, llm: llmAnswering() });
    depsB.sendMail = depsA.sendMail;
    userReplies(env, depsA, t.userId, ['ABC123']);
    depsB.clock.onSleep = depsA.clock.onSleep;

    const [outA, outB] = await Promise.all([
      runSubmission(depsA, env.db, data(t, a.application.id)),
      runSubmission(depsB, env.db, data(t, b.application.id)),
    ]);
    const outcomes = [outA.outcome, outB.outcome].sort();
    expect(outcomes).toEqual(['applied', 'pending']);
    expect(depsA.sender.sent).toHaveLength(1);

    const parkedId = outA.outcome === 'pending' ? a.application.id : b.application.id;
    expect(await getApplication(t.handle, parkedId)).toMatchObject({
      status: 'pending',
      pendingReason: 'captcha-timeout',
    });
    const log = await activity.listByApplication(t.handle, parkedId);
    expect(log.map((e) => e.action)).toContain('captcha-parked');
    const [parkedReq] = await listCaptchaRequestsForApplication(t.handle, parkedId);
    expect(parkedReq).toMatchObject({ tokenHash: null, humanAnswer: null });
    expect(parkedReq!.expiredAt).not.toBeNull();
    expect(depsA.browser.open + depsB.browser.open).toBe(0);
  });

  it('a request left open by a dead worker frees the slot when its window ends', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const b = await seedApplication(t);
    const clock = new FakeClock();
    // A stale open request from a worker that died: window ended 1 s ago.
    const dead = await env.owner.query<{ id: string }>(
      `insert into captcha_requests (tenant_id, user_id, application_id, stage, token_hash, expires_at)
       values ($1, $2, $3, 'human', 'deadbeef', $4) returning id`,
      [t.id, t.userId, a.application.id, new Date(clock.now().getTime() - 1000)],
    );
    expect(dead.rows).toHaveLength(1);
    const adapter = new FakeAdapter();
    adapter.captchas = [new FakeCaptcha('ABC123')];
    const deps = makeDeps(env.db, { adapter, clock, llm: llmAnswering() });
    userReplies(env, deps, t.userId, ['ABC123']);
    const out = await runSubmission(deps, env.db, data(t, b.application.id));
    expect(out.outcome).toBe('applied');
  });
});

describe('rule 13: the window is enforced on the worker side too', () => {
  it('does not enter an answer that is only picked up after the deadline', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering());
    deps.clock.onSleep = async (clock) => {
      // The answer lands, but the worker only wakes up after the 900 s are over.
      await env.owner.query(
        `update captcha_requests set human_answer = 'ABC123'
          where user_id = $1 and stage = 'human' and human_answer is null`,
        [t.userId],
      );
      clock.advance(900_000);
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'captcha-timeout' });
    expect(captcha.entered).not.toContain('ABC123');
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req).toMatchObject({ resolvedAt: null });
    expect(req!.expiredAt).not.toBeNull();
    expect(deps.adapter.submits).toBe(0);
  });
});

describe('rule 15: extending the reservation is serialized and checks ownership', () => {
  async function human(
    t: Awaited<ReturnType<typeof tenant>>,
    appId: string,
    hash: string,
    ms: number,
  ) {
    const r = await env.owner.query<{ id: string }>(
      `insert into captcha_requests (tenant_id, user_id, application_id, stage, token_hash, expires_at)
       values ($1, $2, $3, 'human', $4, now() + ($5 || ' milliseconds')::interval) returning id`,
      [t.id, t.userId, appId, hash, String(ms)],
    );
    return r.rows[0]!.id;
  }

  it('extends the owner of a live reservation using the database clock', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const id = await human(t, a.application.id, 'own-token', 60_000);
    const until = await extendHumanReservation(t.handle, {
      requestId: id,
      userId: t.userId,
      tokenHash: 'own-token',
      windowMs: 900_000,
    });
    expect(Math.abs(until!.getTime() - (Date.now() + 900_000))).toBeLessThan(30_000);
  });

  it('refuses when the reservation expired meanwhile, even if nobody else took the slot', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const id = await human(t, a.application.id, 'late-token', -1000);
    expect(
      await extendHumanReservation(t.handle, {
        requestId: id,
        userId: t.userId,
        tokenHash: 'late-token',
        windowMs: 900_000,
      }),
    ).toBeNull();
  });

  it('refuses when another request holds an open human slot, and when the token is not ours', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const b = await seedApplication(t);
    const first = await human(t, a.application.id, 'tok-a', 60_000);
    await human(t, b.application.id, 'tok-b', 60_000);
    expect(
      await extendHumanReservation(t.handle, {
        requestId: first,
        userId: t.userId,
        tokenHash: 'tok-a',
        windowMs: 900_000,
      }),
    ).toBeNull();
    expect(
      await extendHumanReservation(t.handle, {
        requestId: first,
        userId: t.userId,
        tokenHash: 'someone-else',
        windowMs: 900_000,
      }),
    ).toBeNull();
  });

  it('a reservation lost during a slow send ends the request instead of opening a second one', async () => {
    const captcha = new FakeCaptcha('ABC123');
    const { t, s, deps } = await setup(captcha, llmAnswering());
    const send = deps.sender.send.bind(deps.sender);
    deps.sender.send = async (m) => {
      // The send stalls past the first expiry; the slot is released from under the worker.
      await env.owner.query(
        `update captcha_requests set expires_at = now() - interval '1 second'
          where user_id = $1 and stage = 'human'`,
        [t.userId],
      );
      return send(m);
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'captcha-timeout' });
    const [req] = await listCaptchaRequestsForApplication(t.handle, s.application.id);
    expect(req!.expiredAt).not.toBeNull();
    expect(req!.expiresAt!.getTime()).toBeLessThan(Date.now());
  });
});
