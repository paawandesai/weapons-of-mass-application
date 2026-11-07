import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertApplication,
  recordLlmUsage,
  upsertCompany,
  upsertJob,
  type LlmUsageInput,
} from '@wma/db';
import { usageRoutes } from '../src/routes/usage';
import { appFor, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const app = (t: TestTenant) => appFor(t, { '/usage': usageRoutes });

const call = (over: Partial<LlmUsageInput> & { userId: string }): LlmUsageInput => ({
  purpose: 'discovery',
  applicationId: null,
  model: 'claude-opus-5-5',
  prompt: 'apply-decision/v1',
  usage: {
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  costUsd: 0.006,
  durationMs: 1200,
  ...over,
});

describe('GET /usage', () => {
  it('is all zeros for a new user', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/usage');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      since: null,
      total: {
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cost_usd: 0,
        unpriced_calls: 0,
      },
      by_purpose: [],
      by_application: [],
      recent: [],
    });
  });

  it('sums the ledger and labels applications with company and title', async () => {
    const t = await env.makeTenant();
    const company = await upsertCompany(t.handle, { name: 'Harbor Robotics', createdBy: 'user' });
    const { job } = await upsertJob(t.handle, {
      title: 'Fleet Engineer',
      url: 'https://jobs.harbor.test/1',
      companyId: company.id,
    });
    const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
    await recordLlmUsage(t.handle, call({ userId: t.userId, purpose: 'onboarding', costUsd: 0.4 }));
    await recordLlmUsage(
      t.handle,
      call({
        userId: t.userId,
        purpose: 'application',
        applicationId: application.id,
        prompt: 'resume-tailor/v1',
        costUsd: 0.1,
      }),
    );
    await recordLlmUsage(
      t.handle,
      call({
        userId: t.userId,
        purpose: 'application',
        applicationId: application.id,
        prompt: 'captcha-agent1/v1',
        model: 'mystery',
        costUsd: null,
      }),
    );

    const body = await (await app(t).request('/usage')).json();
    expect(body.total).toMatchObject({ calls: 3, cost_usd: 0.5, unpriced_calls: 1 });
    expect(
      body.by_purpose.map((p: { purpose: string; cost_usd: number }) => [p.purpose, p.cost_usd]),
    ).toEqual([
      ['onboarding', 0.4],
      ['application', 0.1],
    ]);
    expect(body.by_application).toEqual([
      expect.objectContaining({
        application_id: application.id,
        company: 'Harbor Robotics',
        title: 'Fleet Engineer',
        status: 'pending',
        calls: 2,
        cost_usd: 0.1,
        unpriced_calls: 1,
      }),
    ]);
    expect(body.recent).toHaveLength(3);
    expect(body.recent[0]).toMatchObject({
      prompt: 'captcha-agent1/v1',
      model: 'mystery',
      cost_usd: null,
      application_id: application.id,
      purpose: 'application',
    });
    expect(body.recent[2]).toMatchObject({ prompt: 'apply-decision/v1', cost_usd: 0.4 });
  });

  it('applies the window and rejects an unknown one', async () => {
    const t = await env.makeTenant();
    await recordLlmUsage(t.handle, call({ userId: t.userId }));
    const week = await (await app(t).request('/usage?window=7d')).json();
    expect(week.total.calls).toBe(1);
    expect(typeof week.since).toBe('string');
    expect(Date.now() - Date.parse(week.since)).toBeGreaterThan(6 * 86_400_000);
    const bad = await app(t).request('/usage?window=yesterday');
    expect(bad.status).toBe(400);
  });

  it("never shows another user's spend", async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    await recordLlmUsage(a.handle, call({ userId: a.userId, costUsd: 9 }));
    const body = await (await app(b).request('/usage')).json();
    expect(body.total.calls).toBe(0);
  });
});
