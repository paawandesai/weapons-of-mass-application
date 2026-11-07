import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, getApplication } from '@wma/db';
import { runSubmission } from '../../src/submission/job';
import {
  FakeAdapter,
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

async function setup(adapter = new FakeAdapter()) {
  const t = await env.makeTenant();
  await approveProfile(t);
  const s = await seedApplication(t);
  const deps = makeDeps(env.db, { adapter });
  const run = () =>
    runSubmission(deps, env.db, {
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
  return { t, s, deps, run };
}

describe('rule 10: confirmation', () => {
  it('the page marker sets applied_at and the source', async () => {
    const { t, s, deps, run } = await setup();
    const out = await run();
    expect(out).toMatchObject({ outcome: 'applied', source: 'page' });
    const row = await getApplication(t.handle, s.application.id);
    expect(row).toMatchObject({ status: 'applied', confirmationSource: 'page' });
    expect(row!.appliedAt!.getTime()).toBe(deps.clock.now().getTime());
    const submitted = (await activity.listByApplication(t.handle, s.application.id))[0]!;
    expect(submitted).toMatchObject({ action: 'submitted', detail: { source: 'page' } });
    expect(deps.gmailBox.searches).toBe(0);
  });

  it('falls back to a confirmation email that mentions the job title', async () => {
    const adapter = new FakeAdapter();
    adapter.confirmedAfterSubmit = false;
    const { t, s, deps, run } = await setup(adapter);
    let slept = 0;
    deps.clock.onSleep = (clock) => {
      slept += clock.sleeps.at(-1)!;
      if (slept >= 60_000 && deps.gmailBox.messages.length === 0) {
        // An unrelated message first, then the real one.
        deps.gmailBox.add({
          from: 'no-reply@greenhouse.io',
          subject: 'Weekly digest',
          text: 'Jobs you may like',
          receivedAt: clock.now(),
        });
        deps.gmailBox.add({
          from: 'no-reply@us.greenhouse-mail.io',
          subject: `Thank you for applying to ${s.job.title.toUpperCase()} at ${s.companyName}`,
          receivedAt: clock.now(),
        });
      }
    };
    const out = await run();
    expect(out).toMatchObject({ outcome: 'applied', source: 'email' });
    const row = await getApplication(t.handle, s.application.id);
    expect(row).toMatchObject({ status: 'applied', confirmationSource: 'email' });
    const submitted = (await activity.listByApplication(t.handle, s.application.id))[0]!;
    expect(submitted.detail).toMatchObject({ source: 'email', message_id: 'msg-2' });
  });

  it('is unconfirmed after 600 s without either source', async () => {
    const adapter = new FakeAdapter();
    adapter.confirmedAfterSubmit = false;
    const { t, s, deps, run } = await setup(adapter);
    deps.gmailBox.add({
      from: 'no-reply@greenhouse.io',
      subject: 'Something else entirely',
      receivedAt: new Date(Date.now() + 1000),
    });
    const out = await run();
    expect(out).toEqual({ outcome: 'pending', reason: 'unconfirmed' });
    const slept = deps.clock.sleeps.filter((ms) => ms === 15_000).length * 15_000;
    expect(slept).toBe(600_000);
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({
      status: 'pending',
      pendingReason: 'unconfirmed',
      attemptCount: 1,
      appliedAt: null,
    });
    expect(deps.followUps).toHaveLength(0);
  });

  it('an email from before the submit is not a confirmation', async () => {
    const adapter = new FakeAdapter();
    adapter.confirmedAfterSubmit = false;
    const { s, deps, run } = await setup(adapter);
    deps.gmailBox.add({
      from: 'no-reply@greenhouse.io',
      subject: `Thank you for applying: ${s.job.title}`,
      receivedAt: new Date(Date.now() - 86_400_000),
    });
    expect(await run()).toEqual({ outcome: 'pending', reason: 'unconfirmed' });
  });
});
