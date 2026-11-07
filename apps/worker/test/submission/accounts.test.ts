import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activity, getApplication, getAtsCredential, listAtsCredentials, vault } from '@wma/db';
import { generatePassword } from '../../src/submission/accounts';
import { extractVerification } from '../../src/submission/accounts/verification';
import { runSubmission } from '../../src/submission/job';
import type { InboundMessage } from '../../src/submission/types';
import {
  FakeAdapter,
  FakePage,
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

describe('rule 9: passwords', () => {
  it('are 24 characters from the 62-character alphabet and differ every time', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(a).not.toBe(b);
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()).join(''));
    expect(seen.size).toBeGreaterThan(55);
  });
});

describe('rule 9: account creation', () => {
  it('stores the password in the vault and ats_credentials before sign-up submits, and never logs it', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    const before: { cred: unknown; vaulted: unknown; password: string } = {
      cred: null,
      vaulted: null,
      password: '',
    };
    const origSignUp = adapter.signUp.bind(adapter);
    adapter.signUp = async (page, account) => {
      before.password = account.password;
      before.cred = await getAtsCredential(t.handle, t.userId, 'greenhouse', s.companyId);
      before.vaulted = await vault.get(
        t.handle,
        t.userId,
        'ats_password',
        `greenhouse:${s.companyId}`,
      );
      return origSignUp(page, account);
    };
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    const logged = JSON.stringify(spies.flatMap((x) => x.mock.calls));
    spies.forEach((x) => x.mockRestore());

    expect(out.outcome).toBe('applied');
    expect(before.password).toHaveLength(24);
    expect(before.cred).toMatchObject({
      username: t.email,
      vaultRef: `greenhouse:${s.companyId}`,
      rejectedAt: null,
    });
    expect(before.vaulted).toEqual({ ok: true, value: before.password });
    expect(adapter.signUps).toEqual([{ email: t.email, password: before.password }]);

    // The plaintext is nowhere outside the vault: not in its ciphertext, the log or the row.
    const secrets = await env.owner.query('select * from secrets where tenant_id = $1', [t.id]);
    expect(JSON.stringify(secrets.rows)).not.toContain(before.password);
    const log = await activity.listByUser(t.handle, t.userId, { limit: 200 });
    expect(JSON.stringify(log)).not.toContain(before.password);
    expect(JSON.stringify(await getApplication(t.handle, s.application.id))).not.toContain(
      before.password,
    );
    expect(logged).not.toContain(before.password);
    const created = log.find((e) => e.action === 'account-created');
    expect(created?.detail).toEqual({ ats: 'greenhouse', company_id: s.companyId });
  });

  it('creates nothing when the form does not require an account', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(await listAtsCredentials(t.handle, t.userId)).toHaveLength(0);
    expect(deps.adapter.signUps).toHaveLength(0);
  });
});

describe('rule 9: verification from Gmail', () => {
  function verifyingAdapter() {
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    adapter.verifiedAfterSignUp = false;
    adapter.load = async (page: unknown) => {
      adapter.calls.push('load');
      if ((page as FakePage).visited.some((u) => u.includes('verify'))) adapter.signedIn = true;
    };
    return adapter;
  }

  it('follows the first verification link that arrives, polling every 15 s', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = verifyingAdapter();
    const deps = makeDeps(env.db, { adapter });
    let slept = 0;
    deps.clock.onSleep = (clock) => {
      slept += clock.sleeps.at(-1)!;
      if (slept === 45_000) {
        deps.gmailBox.add({
          from: 'no-reply@us.greenhouse-mail.io',
          subject: 'Verify your email',
          text: `Welcome to ${s.companyName}. Confirm your address.`,
          links: [
            'https://boards.greenhouse.io/privacy',
            'https://boards.greenhouse.io/verify?x=1',
          ],
          receivedAt: clock.now(),
        });
      }
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(deps.clock.sleeps.filter((ms) => ms === 15_000).length).toBeGreaterThanOrEqual(3);
    expect(deps.browser.pages[0]!.visited).toEqual(['https://boards.greenhouse.io/verify?x=1']);
    const verified = (await activity.listByApplication(t.handle, s.application.id)).find(
      (e) => e.action === 'account-verified',
    )!;
    expect(verified.detail).toMatchObject({ via: 'link', message_id: 'msg-1' });
  });

  it('enters a 6 to 8 digit code when the message has no link', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = verifyingAdapter();
    const deps = makeDeps(env.db, { adapter });
    deps.gmailBox.add({
      from: 'jobs@acme.greenhouse.io',
      subject: 'Your security code',
      text: `Your ${s.companyName} verification code is 482913. It expires soon.`,
      receivedAt: new Date(Date.now() + 10_000),
    });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(deps.browser.pages[0]!.typed.map((x) => x.value)).toEqual(['482913']);
  });

  it('ignores mail that arrived before sign-up started or from other senders', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = verifyingAdapter();
    const deps = makeDeps(env.db, { adapter });
    deps.gmailBox.add({
      from: 'no-reply@greenhouse.io',
      subject: 'Verify',
      links: ['https://boards.greenhouse.io/verify?old=1'],
      receivedAt: new Date(Date.now() - 3_600_000),
    });
    deps.gmailBox.add({
      from: 'news@elsewhere.test',
      subject: 'Verify',
      links: ['https://elsewhere.test/verify'],
      receivedAt: new Date(Date.now() + 5_000),
    });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'verification-timeout' });
  });

  it('times out after 300 s as verification-timeout', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = verifyingAdapter();
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'verification-timeout' });
    expect(deps.clock.sleeps.reduce((a, b) => a + b, 0)).toBe(300_000);
    expect(deps.adapter.submits).toBe(0);
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({
      status: 'pending',
      pendingReason: 'verification-timeout',
      attemptCount: 1,
    });
  });

  it('extractVerification prefers a verification link, then a code', () => {
    const msg = (over: Partial<InboundMessage>): InboundMessage => ({
      id: 'm',
      from: 'a@greenhouse.io',
      subject: 'Hello',
      receivedAt: new Date(),
      text: '',
      links: [],
      ...over,
    });
    expect(
      extractVerification(
        msg({ links: ['https://x.test/unsubscribe', 'https://x.test/verify/9'] }),
      ),
    ).toMatchObject({ kind: 'link', url: 'https://x.test/verify/9' });
    expect(extractVerification(msg({ text: 'code: 12345678' }))).toMatchObject({
      kind: 'code',
      code: '12345678',
    });
    expect(extractVerification(msg({ text: 'order 12345' }))).toBeNull();
    expect(extractVerification(msg({ links: ['http://x.test/verify'] }))).toBeNull();
  });
});

describe('rule 9: credential reuse and rejection', () => {
  it('signs in with the stored credential on the second application at the same company', async () => {
    const t = await tenant();
    const first = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, first.application.id));
    const created = adapter.signUps[0]!;

    adapter.signedIn = false;
    const second = await seedApplication(t, { companyId: first.companyId });
    const out = await runSubmission(deps, env.db, data(t, second.application.id));
    expect(out.outcome).toBe('applied');
    expect(adapter.signUps).toHaveLength(1);
    expect(adapter.signIns).toEqual([{ username: t.email, password: created.password }]);
    expect(await listAtsCredentials(t.handle, t.userId)).toHaveLength(1);
    const actions = (await activity.listByApplication(t.handle, second.application.id)).map(
      (e) => e.action,
    );
    expect(actions).toContain('account-signed-in');
    expect(actions).not.toContain('account-created');
  });

  it('flags a rejected credential, parks the application and never creates a new account', async () => {
    const t = await tenant();
    const first = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, first.application.id));

    adapter.signedIn = false;
    adapter.signInOutcome = 'rejected';
    const second = await seedApplication(t, { companyId: first.companyId });
    const out = await runSubmission(deps, env.db, data(t, second.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'credential-rejected' });
    const cred = await getAtsCredential(t.handle, t.userId, 'greenhouse', first.companyId);
    expect(cred?.rejectedAt).not.toBeNull();
    expect(adapter.signUps).toHaveLength(1);

    // The flag stands: the next application does not even try the credential.
    const third = await seedApplication(t, { companyId: first.companyId });
    const signIns = adapter.signIns.length;
    expect(await runSubmission(deps, env.db, data(t, third.application.id))).toEqual({
      outcome: 'pending',
      reason: 'credential-rejected',
    });
    expect(adapter.signIns).toHaveLength(signIns);
    expect(adapter.signUps).toHaveLength(1);
  });

  it('treats a missing or corrupt vault entry as credential-rejected', async () => {
    const t = await tenant();
    const first = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, first.application.id));
    await vault.delete(t.handle, t.userId, 'ats_password', `greenhouse:${first.companyId}`);

    adapter.signedIn = false;
    const second = await seedApplication(t, { companyId: first.companyId });
    const out = await runSubmission(deps, env.db, data(t, second.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'credential-rejected' });
    expect(adapter.signUps).toHaveLength(1);
    expect(adapter.signIns).toHaveLength(0);
  });
});
