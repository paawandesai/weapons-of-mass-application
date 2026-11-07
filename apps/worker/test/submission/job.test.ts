import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  getFile,
  lockForAttempt,
  updateApplication,
  type TenantHandle,
} from '@wma/db';
import {
  createSubmissionRunner,
  runSubmission,
  type SubmissionJobData,
} from '../../src/submission/job';
import type { AnswerResolution } from '../../src/submission/types';
import {
  FakeAdapter,
  FIELDS,
  approveProfile,
  makeDeps,
  seedApplication,
  setupSubmissionEnv,
  type DepsOptions,
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

async function actions(handle: TenantHandle, applicationId: string) {
  return (await activity.listByApplication(handle, applicationId, { limit: 200 }))
    .reverse()
    .map((e) => e.action);
}

describe('rule 1: the job only moves a pending row nobody else holds', () => {
  it('logs duplicate_enqueue and does nothing when the status is not pending', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    await updateApplication(t.handle, s.application.id, { status: 'applied' });
    const deps = makeDeps(env.db);
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'duplicate', why: 'not_pending' });
    expect(deps.browser.launches).toBe(0);
    expect(deps.tailorCalls).toBe(0);
    expect(await actions(t.handle, s.application.id)).toEqual(['duplicate_enqueue']);
    expect((await getApplication(t.handle, s.application.id))?.attemptCount).toBe(0);
  });

  it('skips a row another attempt holds (for update skip locked) and logs it', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = t.handle.transaction(async (h) => {
      await lockForAttempt(h, s.application.id);
      held();
      await new Promise<void>((r) => (release = r));
    });
    await holding;
    const deps = makeDeps(env.db);
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    release();
    await holder;
    expect(out).toEqual({ outcome: 'duplicate', why: 'locked' });
    expect(deps.browser.launches).toBe(0);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.filter((e) => e.action === 'duplicate_enqueue')).toHaveLength(1);
    expect((await getApplication(t.handle, s.application.id))?.status).toBe('pending');
  });

  it('runs one attempt when the same application is enqueued twice at once', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.loadDelayMs = 150;
    const deps = makeDeps(env.db, { adapter });
    const results = await Promise.all([
      runSubmission(deps, env.db, data(t, s.application.id)),
      runSubmission(deps, env.db, data(t, s.application.id)),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'duplicate']);
    expect(adapter.submits).toBe(1);
    expect(deps.followUps).toHaveLength(1);
  });

  it('does nothing for a user without an approved profile', async () => {
    const t = await env.makeTenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'skipped', reason: 'profile_not_approved' });
    expect(deps.browser.launches).toBe(0);
    expect((await getApplication(t.handle, s.application.id))?.status).toBe('pending');
  });
});

describe('rule 2: a prior confirmation is honoured before any browser action', () => {
  it('moves a retried application straight to applied from a confirmation email', async () => {
    const t = await tenant();
    const s = await seedApplication(t, { attemptCount: 1 });
    await activity.logActivity(t.handle, {
      userId: t.userId,
      applicationId: s.application.id,
      actor: 'agent',
      action: 'submission-started',
    });
    const deps = makeDeps(env.db);
    deps.gmailBox.add({
      from: 'no-reply@us.greenhouse-mail.io',
      subject: `Thank you for applying to ${s.companyName}: ${s.job.title}`,
      receivedAt: new Date(Date.now() + 1000),
    });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toMatchObject({ outcome: 'applied', source: 'email', prior: true });
    expect(deps.browser.launches).toBe(0);
    expect(deps.tailorCalls).toBe(0);
    const row = await getApplication(t.handle, s.application.id);
    expect(row).toMatchObject({ status: 'applied', confirmationSource: 'email' });
    expect(row?.appliedAt).not.toBeNull();
    const submitted = (await activity.listByApplication(t.handle, s.application.id)).find(
      (e) => e.action === 'submitted',
    );
    expect(submitted?.detail).toMatchObject({ source: 'email', prior: true });
  });

  it('does not look for one on a first attempt', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(deps.gmailBox.searches).toBe(0);
  });
});

describe('rule 3: step order, each step with its state change and log entry', () => {
  it('writes the entries in order and the resume reference with the tailored step', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toMatchObject({ outcome: 'applied', source: 'page', prior: false });
    expect(await actions(t.handle, s.application.id)).toEqual([
      'submission-started',
      'tailored',
      'filled',
      'submitting',
      'submitted',
    ]);
    expect(deps.adapter.calls).toEqual(['load', 'fields', 'attachResume', 'fill', 'submit']);
    const row = await getApplication(t.handle, s.application.id);
    expect(row).toMatchObject({
      status: 'applied',
      confirmationSource: 'page',
      pendingReason: null,
      resumePdfRef: `tenants/${t.id}/applications/${s.application.id}/resume.pdf`,
      unmetRequirements: ['Rust'],
    });
    expect(row?.appliedAt).not.toBeNull();
  });

  it('runs the account step between load and fill when the form needs one', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.needsAccount = true;
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(await actions(t.handle, s.application.id)).toEqual([
      'submission-started',
      'tailored',
      'account-created',
      'filled',
      'submitting',
      'submitted',
    ]);
  });

  it('a crash during submit leaves the last step as the evidence', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.beforeSubmit = () => {
      throw new Error('browser died');
    };
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, s.application.id));
    const names = await actions(t.handle, s.application.id);
    expect(names.slice(-2)).toEqual(['submitting', 'browser-error']);
  });
});

describe('rule 4: pending reasons', () => {
  const cases: Array<{
    reason: string;
    opts: () => DepsOptions;
    page: boolean;
  }> = [
    {
      reason: 'tailoring-check-failed',
      opts: () => ({
        tailor: () => ({
          ok: false,
          reason: 'tailoring-check-failed',
          detail: 'invalid_facts',
          failures: ['employer "Globex" not in profile'],
        }),
      }),
      page: false,
    },
    { reason: 'unsupported-ats', opts: () => ({ unsupported: true }), page: false },
    {
      reason: 'unmapped-field',
      opts: () => ({
        resolveAnswers: async (_c, fields) =>
          fields
            .filter((f) => f.id !== 'name')
            .map((f): AnswerResolution => ({
              fieldId: f.id,
              question: f.label,
              status: 'filled',
              value: 'x',
              source: 'profile',
            })),
      }),
      page: true,
    },
    {
      reason: 'missing-profile-field',
      opts: () => ({
        resolveAnswers: async (_c, fields) =>
          fields.map((f): AnswerResolution =>
            f.id === 'name'
              ? { fieldId: f.id, question: f.label, status: 'missing-profile-field' }
              : {
                  fieldId: f.id,
                  question: f.label,
                  status: 'skipped',
                  skipped: 'self-identification',
                },
          ),
      }),
      page: true,
    },
    {
      reason: 'unanswerable-question',
      opts: () => ({
        resolveAnswers: async (_c, fields) =>
          fields.map((f): AnswerResolution =>
            f.id === 'name'
              ? { fieldId: f.id, question: f.label, status: 'unanswerable' }
              : {
                  fieldId: f.id,
                  question: f.label,
                  status: 'skipped',
                  skipped: 'self-identification',
                },
          ),
      }),
      page: true,
    },
    {
      reason: 'unconfirmed',
      opts: () => {
        const adapter = new FakeAdapter();
        adapter.confirmedAfterSubmit = false;
        return { adapter };
      },
      page: true,
    },
    {
      reason: 'browser-error',
      opts: () => {
        const adapter = new FakeAdapter();
        adapter.loadError = new Error('net::ERR_CONNECTION_RESET');
        return { adapter };
      },
      page: true,
    },
  ];

  for (const c of cases) {
    it(`${c.reason}: pending, attempt_count 1, reason logged${c.page ? ', screenshot stored' : ', no browser'}`, async () => {
      const t = await tenant();
      const s = await seedApplication(t);
      const deps = makeDeps(env.db, c.opts());
      const out = await runSubmission(deps, env.db, data(t, s.application.id));
      expect(out).toEqual({ outcome: 'pending', reason: c.reason });
      const row = await getApplication(t.handle, s.application.id);
      expect(row).toMatchObject({ status: 'pending', pendingReason: c.reason, attemptCount: 1 });
      const log = await activity.listByApplication(t.handle, s.application.id);
      expect(log[0]).toMatchObject({ action: c.reason });
      const shot = await getFile(
        t.handle,
        `tenants/${t.id}/applications/${s.application.id}/failure-1.png`,
      );
      expect(shot !== null).toBe(c.page);
      if (!c.page) expect(deps.browser.launches).toBe(0);
      expect(deps.browser.open).toBe(0);
    });
  }

  it('a required upload other than the resume is an unmapped field', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.fieldList = [
      ...FIELDS,
      {
        id: 'transcript',
        label: 'Transcript',
        type: 'file',
        required: true,
        maxLength: null,
        classification: 'free-text',
      },
    ];
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out).toEqual({ outcome: 'pending', reason: 'unmapped-field' });
    expect(adapter.submits).toBe(0);
    const entry = (await activity.listByApplication(t.handle, s.application.id))[0]!;
    expect(entry.detail).toMatchObject({ field: 'Transcript' });
    expect(
      await getFile(t.handle, `tenants/${t.id}/applications/${s.application.id}/failure-1.png`),
    ).not.toBeNull();
  });

  it('names the field that could not be mapped', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const [first] = cases.filter((c) => c.reason === 'unmapped-field');
    const deps = makeDeps(env.db, first!.opts());
    await runSubmission(deps, env.db, data(t, s.application.id));
    const entry = (await activity.listByApplication(t.handle, s.application.id))[0]!;
    expect(entry.detail).toMatchObject({ field: 'Full name', attempt: 1 });
    expect(deps.adapter.submits).toBe(0);
  });
});

describe('rule 5: one retry, then closed', () => {
  it('two consecutive runs over a failing application end closed submission-failed', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.loadError = new Error('boom');
    const deps = makeDeps(env.db, { adapter });
    expect(await runSubmission(deps, env.db, data(t, s.application.id))).toEqual({
      outcome: 'pending',
      reason: 'browser-error',
    });
    expect(await runSubmission(deps, env.db, data(t, s.application.id))).toEqual({
      outcome: 'closed',
      reason: 'submission-failed',
    });
    const row = await getApplication(t.handle, s.application.id);
    expect(row).toMatchObject({
      status: 'closed',
      closedReason: 'submission-failed',
      attemptCount: 2,
    });
    expect(
      await actions(t.handle, s.application.id).then((a) => a.filter((x) => x === 'closed')),
    ).toEqual(['closed']);
    // A third enqueue is a duplicate.
    expect(await runSubmission(deps, env.db, data(t, s.application.id))).toMatchObject({
      outcome: 'duplicate',
    });
  });

  it('a retry that succeeds ends applied and clears the pending reason', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.loadError = new Error('boom');
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, s.application.id));
    adapter.loadError = null;
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({
      status: 'applied',
      pendingReason: null,
      attemptCount: 1,
    });
  });

  it('never closes an unsupported ATS on the retry count', async () => {
    const t = await tenant();
    const s = await seedApplication(t, { attemptCount: 1 });
    const deps = makeDeps(env.db, { unsupported: true });
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(await getApplication(t.handle, s.application.id)).toMatchObject({
      status: 'pending',
      pendingReason: 'unsupported-ats',
      attemptCount: 2,
    });
  });
});

describe('rule 7: answers are on the row before submit', () => {
  it('records every question, self-identification as skipped, before submit runs', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    let seen: unknown = null;
    adapter.beforeSubmit = async () => {
      seen = (await getApplication(t.handle, s.application.id))?.formAnswers;
    };
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(seen).toEqual({
      'Full name': 'Mara Quill',
      Resume: { attached: 'resume.pdf' },
      'Why do you want to work here?': 'Because the work is interesting.',
      Gender: { skipped: 'self-identification' },
    });
    // Self-identification is never typed into the form.
    expect(adapter.filled[0]).toEqual({
      name: 'Mara Quill',
      why: 'Because the work is interesting.',
    });
  });

  it('attaches nothing and proceeds when the form has no resume field', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.fieldList = FIELDS.filter((f) => f.classification !== 'resume');
    const deps = makeDeps(env.db, { adapter });
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect(adapter.attached).toBe(0);
  });
});

describe('rule 11: follow-up', () => {
  it('is enqueued once, seven days after applied_at', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    await runSubmission(deps, env.db, data(t, s.application.id));
    // A second success for the same application cannot enqueue again.
    expect(await runSubmission(deps, env.db, data(t, s.application.id))).toMatchObject({
      outcome: 'duplicate',
    });
    const row = await getApplication(t.handle, s.application.id);
    expect(deps.followUps).toHaveLength(1);
    expect(deps.followUps[0]!.data).toEqual({
      tenantId: t.id,
      userId: t.userId,
      applicationId: s.application.id,
    });
    expect(deps.followUps[0]!.startAfter.getTime()).toBe(row!.appliedAt!.getTime() + 7 * 86400_000);
  });

  it('a failed enqueue does not undo applied', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const deps = makeDeps(env.db);
    deps.followUp = {
      enqueueFollowUp: async () => {
        throw new Error('queue down');
      },
    };
    const out = await runSubmission(deps, env.db, data(t, s.application.id));
    expect(out.outcome).toBe('applied');
    expect((await getApplication(t.handle, s.application.id))?.status).toBe('applied');
    expect(await actions(t.handle, s.application.id)).toContain('follow-up-not-scheduled');
  });
});

describe('rule 16: one context per application, closed in finally, concurrency 2', () => {
  it('closes the context after a failure', async () => {
    const t = await tenant();
    const s = await seedApplication(t);
    const adapter = new FakeAdapter();
    adapter.loadError = new Error('boom');
    const deps = makeDeps(env.db, { adapter });
    await runSubmission(deps, env.db, data(t, s.application.id));
    expect(deps.browser.opened).toBe(1);
    expect(deps.browser.closed).toBe(1);
  });

  it('five queued applications never have more than two contexts open', async () => {
    const t = await tenant();
    const seeded = await Promise.all([1, 2, 3, 4, 5].map(() => seedApplication(t)));
    const adapter = new FakeAdapter();
    adapter.loadDelayMs = 80;
    const deps = makeDeps(env.db, { adapter });
    const runner = createSubmissionRunner(deps, env.db, { concurrency: 2 });
    const results = await Promise.all(seeded.map((s) => runner.run(data(t, s.application.id))));
    expect(results.every((r) => r.outcome === 'applied')).toBe(true);
    expect(deps.browser.opened).toBe(5);
    expect(deps.browser.closed).toBe(5);
    expect(deps.browser.maxOpen).toBe(2);
  }, 30000);
});
