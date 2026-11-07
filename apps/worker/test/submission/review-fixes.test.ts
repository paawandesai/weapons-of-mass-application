import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  getAtsCredential,
  getFile,
  insertAtsCredential,
  vault,
} from '@wma/db';
import { InfrastructureError, describeError, sanitizeMessage } from '../../src/submission/failure';
import { reconcileFollowUps } from '../../src/submission/followup';
import {
  domainAllowed,
  fromAllowedDomains,
  matchesCompany,
  senderDomain,
} from '../../src/submission/domains';
import { runSubmission, type SubmissionJobData } from '../../src/submission/job';
import type { FollowUpJobData } from '../../src/submission/deps';
import {
  FakeAdapter,
  FakeClock,
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
const data = (t: { id: string; userId: string }, applicationId: string): SubmissionJobData => ({
  tenantId: t.id,
  userId: t.userId,
  applicationId,
});
const PASSWORD = 'Zx9QkLm2PwRt7VbN4cYd8HsJ';

describe('failure details carry a category and a sanitized message, never a secret', () => {
  it('cuts everything after the word password, replaces URLs and redacts token-like runs', () => {
    expect(
      sanitizeMessage('locator.fill: Timeout waiting for input[name=password] fill "abc"'),
    ).toBe('locator.fill: Timeout waiting for input[name=');
    expect(
      sanitizeMessage('page.goto: net::ERR failed at https://x.test/verify?token=abc123 now'),
    ).toBe('page.goto: net::ERR failed at [url]');
    expect(sanitizeMessage('bad value Zx9QkLm2PwRt7VbN4cYd8HsJ here')).toBe(
      'bad value [redacted] here',
    );
    expect(sanitizeMessage(`typed ${PASSWORD}`, [PASSWORD])).toBe('typed [redacted]');
    expect(describeError(new (class Weird extends Error {})('boom'))).toEqual({
      error: 'Error',
      message: 'boom',
    });
  });

  it('a password in a thrown error never reaches activity_log', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    adapter.signUp = async (_p, account) => {
      throw new Error(
        `locator.fill: Timeout 30000ms exceeded. fill("${account.password}") at https://boards.greenhouse.io/verify?token=${account.password}`,
      );
    };
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'browser-error' });
    // The detail endpoint returns activity_log.detail verbatim, so this is the whole surface.
    const rows = await env.owner.query(
      'select action, detail from activity_log where tenant_id = $1',
      [t.id],
    );
    const stored = await vault.get(t.handle, t.userId, 'ats_password', `greenhouse:${s.companyId}`);
    expect(stored.ok).toBe(true);
    const plaintext = stored.ok ? stored.value : '';
    expect(plaintext).toHaveLength(24);
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain(plaintext);
    expect(dump).not.toContain('token=');
    expect(dump).not.toContain('https://');
    const failure = rows.rows.find((r) => r.action === 'browser-error');
    expect(failure.detail).toMatchObject({ error: 'Error' });
  });
});

describe('infrastructure failures propagate; recorded outcomes do not', () => {
  it('a database error with no outcome committed rejects, leaving the row untouched', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db, {
      tailor: () => {
        throw Object.assign(new Error('terminating connection'), { code: '57P01' });
      },
    });
    await expect(runSubmission(deps, env.db, data(t, s.application.id))).rejects.toThrow(
      'terminating connection',
    );
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      pendingReason: null,
    });
  });

  it('a profile that cannot be loaded rejects instead of acknowledging the job', async () => {
    const t = await tenant();
    await env.owner.query(
      `update profiles set document = '{"broken":true}'::jsonb where tenant_id = $1`,
      [t.id],
    );
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    await expect(runSubmission(deps, env.db, data(t, s.application.id))).rejects.toBeInstanceOf(
      InfrastructureError,
    );
    expect((await getApplication(t.handle, s.application.id))?.attemptCount).toBe(0);
  });

  it('an application failure is recorded and resolves', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.fillError = new Error('element detached');
    const deps = makeDeps(env.db, { adapter });
    await expect(runSubmission(deps, env.db, data(t, s.application.id))).resolves.toEqual({
      outcome: 'pending',
      reason: 'browser-error',
    });
  });
});

describe('failure recording finishes before the browser context closes', () => {
  it('stores the failure screenshot even when taking it is slow', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.fillError = new Error('element detached');
    const deps = makeDeps(env.db, { adapter });
    const open = deps.launchBrowser;
    deps.launchBrowser = async () => {
      const b = await open();
      const newContext = b.newContext.bind(b);
      b.newContext = async () => {
        const ctx = await newContext();
        const newPage = ctx.newPage.bind(ctx);
        ctx.newPage = async () => {
          const p = await newPage();
          (p as unknown as { screenshotDelayMs: number }).screenshotDelayMs = 40;
          return p;
        };
        return ctx;
      };
      return b;
    };
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(deps.browser.closedMidScreenshot).toBe(0);
    const failure = (await activity.listByApplication(t.handle, s.application.id)).find(
      (e) => e.action === 'browser-error',
    );
    const shot = (failure?.detail as { screenshot?: string }).screenshot;
    expect(shot).toBe(`tenants/${t.id}/applications/${s.application.id}/failure-1.png`);
    expect(await getFile(t.handle, shot!)).not.toBeNull();
  });
});

describe('form answers commit with the filled entry', () => {
  it('a fill that fails leaves no committed answers', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.fillError = new Error('element detached');
    await runSubmission(makeDeps(env.db, { adapter }), env.db, data(t, s.application.id));
    expect((await getApplication(t.handle, s.application.id))?.formAnswers).toEqual({});
  });

  it('a successful fill writes the answers in the same step as `filled`, before submit', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    let atSubmit: unknown = null;
    adapter.beforeSubmit = async () => {
      atSubmit = (await getApplication(t.handle, s.application.id))?.formAnswers;
    };
    await runSubmission(makeDeps(env.db, { adapter }), env.db, data(t, s.application.id));
    expect(Object.keys(atSubmit as object).length).toBeGreaterThan(0);
    const filled = (await activity.listByApplication(t.handle, s.application.id)).find(
      (e) => e.action === 'filled',
    );
    expect(filled).toBeDefined();
  });
});

describe('accounts: serialized creation and a recoverable registration', () => {
  it('two applications at one company create one account and share its password', async () => {
    const t = await tenant();
    const a = await seedApplication(t);
    const b = await seedApplication(t, { companyId: a.companyId });
    const adapterA = new FakeAdapter();
    const adapterB = new FakeAdapter();
    adapterA.needsAccount = adapterB.needsAccount = true;
    adapterA.loadDelayMs = adapterB.loadDelayMs = 30;
    const [outA, outB] = await Promise.all([
      runSubmission(makeDeps(env.db, { adapter: adapterA }), env.db, data(t, a.application.id)),
      runSubmission(makeDeps(env.db, { adapter: adapterB }), env.db, data(t, b.application.id)),
    ]);
    expect([outA.outcome, outB.outcome]).toEqual(['applied', 'applied']);
    const signUps = [...adapterA.signUps, ...adapterB.signUps];
    const signIns = [...adapterA.signIns, ...adapterB.signIns];
    expect(signUps).toHaveLength(1);
    expect(signIns).toHaveLength(1);
    expect(signIns[0]!.password).toBe(signUps[0]!.password);
    const stored = await vault.get(t.handle, t.userId, 'ats_password', `greenhouse:${a.companyId}`);
    expect(stored).toEqual({ ok: true, value: signUps[0]!.password });
  });

  it('a credential left registering is resumed with its vaulted password, not signed in', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    await vault.put(t.handle, t.userId, 'ats_password', `greenhouse:${s.companyId}`, PASSWORD);
    await insertAtsCredential(t.handle, {
      userId: t.userId,
      ats: 'greenhouse',
      companyId: s.companyId,
      username: t.email,
      vaultRef: `greenhouse:${s.companyId}`,
    });
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    const out = await runSubmission(
      makeDeps(env.db, { adapter }),
      env.db,
      data(t, s.application.id),
    );
    expect(out.outcome).toBe('applied');
    expect(adapter.signIns).toHaveLength(0);
    expect(adapter.signUps).toEqual([{ email: t.email, password: PASSWORD }]);
    expect(await getAtsCredential(t.handle, t.userId, 'greenhouse', s.companyId)).toMatchObject({
      status: 'verified',
      rejectedAt: null,
    });
  });

  it('a resumed sign-up the vendor refuses falls back to signing in, and a bad sign-in is not final', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    await vault.put(t.handle, t.userId, 'ats_password', `greenhouse:${s.companyId}`, PASSWORD);
    await insertAtsCredential(t.handle, {
      userId: t.userId,
      ats: 'greenhouse',
      companyId: s.companyId,
      username: t.email,
      vaultRef: `greenhouse:${s.companyId}`,
    });
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    adapter.signUpError = new Error('sign-up rejected: email already taken');
    adapter.signInOutcome = 'rejected';
    const out = await runSubmission(
      makeDeps(env.db, { adapter }),
      env.db,
      data(t, s.application.id),
    );
    expect(out).toEqual({ outcome: 'pending', reason: 'credential-rejected' });
    expect(adapter.signIns).toEqual([{ username: t.email, password: PASSWORD }]);
    // Not marked rejected: the account may only be waiting for verification.
    expect(await getAtsCredential(t.handle, t.userId, 'greenhouse', s.companyId)).toMatchObject({
      status: 'registering',
      rejectedAt: null,
    });
  });

  it('verification mail naming another company on the same ATS is not used', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const other = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    adapter.verifiedAfterSignUp = false;
    const deps = makeDeps(env.db, { adapter });
    deps.clock.onSleep = (clock) => {
      deps.gmailBox.add({
        from: 'no-reply@greenhouse.io',
        subject: 'Verify your email',
        text: `Welcome to ${other.companyName}.`,
        links: ['https://boards.greenhouse.io/verify?x=1'],
        receivedAt: clock.now(),
      });
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'verification-timeout' });
    expect(adapter.calls).not.toContain('signIn');
    expect(deps.browser.pages[0]!.visited).toHaveLength(0);
  });
});

describe('sender and company correlation', () => {
  it('parses the sender address and requires the domain or a subdomain', () => {
    expect(senderDomain('Jobs <jobs@Acme.greenhouse.io>')).toBe('acme.greenhouse.io');
    expect(senderDomain('greenhouse.io <attacker@evil.test>')).toBe('evil.test');
    expect(senderDomain('no-reply@greenhouse.io')).toBe('greenhouse.io');
    expect(senderDomain('not an address')).toBeNull();
    expect(domainAllowed('acme.greenhouse.io', ['greenhouse.io'])).toBe(true);
    expect(domainAllowed('notgreenhouse.io', ['greenhouse.io'])).toBe(false);
    expect(domainAllowed('greenhouse.io.evil.test', ['greenhouse.io'])).toBe(false);
    const msgs = [
      { from: 'greenhouse.io <a@evil.test>' },
      { from: 'X <a@us.greenhouse-mail.io>' },
      { from: 'a@xgreenhouse-mail.io' },
    ];
    expect(fromAllowedDomains(msgs, ['greenhouse-mail.io'])).toEqual([msgs[1]]);
  });

  it('an ATS message counts for a company only when it names that company', () => {
    const job = { url: 'https://boards.greenhouse.io/acme/jobs/1' };
    const base = { id: '1', receivedAt: new Date(), links: [] as string[] };
    const mail = (text: string, from = 'no-reply@greenhouse.io') => ({
      ...base,
      from,
      subject: 'Thanks',
      text,
    });
    const company = { name: 'Acme Corp', job };
    expect(matchesCompany(mail('Thanks for applying to Acme Corp'), company)).toBe(true);
    expect(matchesCompany(mail('Thanks for applying to Globex'), company)).toBe(false);
    expect(matchesCompany(mail('Acme Corporation of Nowhere'), { name: 'Acme', job })).toBe(true);
    expect(matchesCompany(mail('Thanks', 'talent@acme.com'), company)).toBe(true);
    expect(matchesCompany(mail('Acme Corp', 'x@evil.test'), company)).toBe(false);
  });

  it('a confirmation for another company with the same title does not mark this one applied', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const other = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.confirmedAfterSubmit = false;
    const deps = makeDeps(env.db, { adapter });
    deps.clock.onSleep = (clock) => {
      if (deps.gmailBox.messages.length === 0)
        deps.gmailBox.add({
          from: 'no-reply@us.greenhouse-mail.io',
          subject: `Thank you for applying: ${s.job.title}`,
          text: `Your application to ${other.companyName} was received.`,
          receivedAt: clock.now(),
        });
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'unconfirmed' });
  });
});

describe('reconciling an uncertain submission before filling again', () => {
  async function submittedBefore(opts: { confirmedOnLoad?: boolean } = {}) {
    const t = await tenant();
    const s = await seedApplication(t, { attemptCount: 1 });
    const clock = new FakeClock();
    for (const action of ['submission-started', 'submitting']) {
      await activity.logActivity(t.handle, {
        userId: t.userId,
        applicationId: s.application.id,
        actor: 'agent',
        action,
      });
    }
    const adapter = new FakeAdapter();
    adapter.confirmedOnLoad = opts.confirmedOnLoad ?? false;
    const deps = makeDeps(env.db, { adapter, clock });
    return { t, s, deps, adapter };
  }

  it('applies from the vendor page confirmation without tailoring or submitting', async () => {
    const { t, s, deps, adapter } = await submittedBefore({ confirmedOnLoad: true });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toMatchObject({ outcome: 'applied', source: 'page', prior: true });
    expect(deps.tailorCalls).toBe(0);
    expect(adapter.submits).toBe(0);
    expect(deps.browser.open).toBe(0);
  });

  it('waits out the confirmation window for a delayed email before submitting again', async () => {
    const { t, s, deps, adapter } = await submittedBefore();
    let polls = 0;
    deps.clock.onSleep = (clock) => {
      if (++polls === 3)
        deps.gmailBox.add({
          from: 'no-reply@us.greenhouse-mail.io',
          subject: `Thank you for applying to ${s.companyName}: ${s.job.title}`,
          receivedAt: new Date(clock.now().getTime() + 1),
        });
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toMatchObject({ outcome: 'applied', source: 'email', prior: true });
    expect(adapter.submits).toBe(0);
    expect(deps.tailorCalls).toBe(0);
  });

  it('submits again only after both checks come up empty', async () => {
    const { t, s, deps, adapter } = await submittedBefore();
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(adapter.submits).toBe(1);
    expect(deps.gmailBox.searches).toBeGreaterThan(1);
  });
});

describe('follow-up outbox', () => {
  it('an applied row whose enqueue failed stays owed, and reconciliation repairs it once', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    deps.followUp.enqueueFollowUp = async () => {
      throw new Error('queue down');
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({
      status: 'applied',
      followUpEnqueuedAt: null,
    });

    const queued: Array<{ data: FollowUpJobData; startAfter: Date }> = [];
    const queue = {
      async enqueueFollowUp(d: FollowUpJobData, startAfter: Date) {
        queued.push({ data: d, startAfter });
      },
    };
    await reconcileFollowUps({ db: env.db, queue });
    const mine = queued.filter((q) => q.data.applicationId === s.application.id);
    expect(mine).toHaveLength(1);
    const row = await getApplication(t.handle, s.application.id);
    expect(row?.followUpEnqueuedAt).not.toBeNull();
    expect(mine[0]!.startAfter.getTime()).toBe(row!.appliedAt!.getTime() + 7 * 86_400_000);

    await reconcileFollowUps({ db: env.db, queue });
    expect(queued.filter((q) => q.data.applicationId === s.application.id)).toHaveLength(1);
  });

  it('a normal success records the enqueue on the row', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(deps.followUps).toHaveLength(1);
    expect((await getApplication(t.handle, s.application.id))?.followUpEnqueuedAt).not.toBeNull();
  });
});

describe('queue options', () => {
  it('exports stable send options with retries', async () => {
    const { SUBMIT_QUEUE_OPTIONS } = await import('../../src/jobs/submit-application');
    expect(SUBMIT_QUEUE_OPTIONS.retryLimit).toBeGreaterThan(0);
    expect(SUBMIT_QUEUE_OPTIONS.retryBackoff).toBe(true);
  });
});
