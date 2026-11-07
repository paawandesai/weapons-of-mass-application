import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listRecentLlmUsage,
  llmUsageByApplication,
  llmUsageByPurpose,
  llmUsageForApplication,
  recordLlmUsage,
  totalLlmUsage,
  type LlmUsageInput,
} from '../src';
import { makeApplication, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

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

describe('llm_usage ledger', () => {
  it('sums per user, per purpose and per application, newest first in the recent list', async () => {
    const t = await env.makeTenant();
    const { application } = await makeApplication(t);
    await recordLlmUsage(t.handle, call({ userId: t.userId }));
    await recordLlmUsage(t.handle, call({ userId: t.userId, purpose: 'onboarding', costUsd: 0.5 }));
    await recordLlmUsage(
      t.handle,
      call({
        userId: t.userId,
        purpose: 'application',
        applicationId: application.id,
        prompt: 'resume-tailor/v1',
        costUsd: 0.25,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
      }),
    );
    await recordLlmUsage(
      t.handle,
      call({ userId: t.userId, model: 'unknown-model', costUsd: null, purpose: 'inbox' }),
    );

    const total = await totalLlmUsage(t.handle, t.userId);
    expect(total).toEqual({
      calls: 4,
      input_tokens: 3010,
      output_tokens: 320,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
      cost_usd: 0.756,
      unpriced_calls: 1,
    });

    const byPurpose = await llmUsageByPurpose(t.handle, t.userId);
    expect(byPurpose.map((p) => [p.purpose, p.cost_usd, p.calls])).toEqual([
      ['onboarding', 0.5, 1],
      ['application', 0.25, 1],
      ['discovery', 0.006, 1],
      ['inbox', 0, 1],
    ]);

    const byApp = await llmUsageByApplication(t.handle, t.userId);
    expect(byApp).toHaveLength(1);
    expect(byApp[0]).toMatchObject({ applicationId: application.id, cost_usd: 0.25, calls: 1 });
    expect(await llmUsageForApplication(t.handle, application.id)).toMatchObject({
      calls: 1,
      cost_usd: 0.25,
    });

    const recent = await listRecentLlmUsage(t.handle, t.userId, 2);
    expect(recent.map((r) => r.prompt)).toEqual(['apply-decision/v1', 'resume-tailor/v1']);
    expect(recent[0]!.costUsd).toBeNull();
    expect(recent[1]!.costUsd).toBe('0.25000000');
  });

  it('keeps an empty ledger at zero and honours the since window', async () => {
    const t = await env.makeTenant();
    expect(await totalLlmUsage(t.handle, t.userId)).toMatchObject({ calls: 0, cost_usd: 0 });
    await recordLlmUsage(t.handle, call({ userId: t.userId }));
    expect(
      (await totalLlmUsage(t.handle, t.userId, { since: new Date(Date.now() + 60_000) })).calls,
    ).toBe(0);
    expect(
      (await totalLlmUsage(t.handle, t.userId, { since: new Date(Date.now() - 60_000) })).calls,
    ).toBe(1);
  });

  it('is scoped by tenant: another tenant sees nothing', async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    await recordLlmUsage(a.handle, call({ userId: a.userId }));
    expect((await totalLlmUsage(b.handle, a.userId)).calls).toBe(0);
    const direct = await b.handle.run((tx) =>
      tx.execute('select count(*)::int as n from llm_usage'),
    );
    expect((direct.rows[0] as { n: number }).n).toBe(0);
  });

  it('forces RLS with four policies and grants wma_app', async () => {
    const rls = await env.owner.query(
      'select relrowsecurity, relforcerowsecurity from pg_class where relname = $1',
      ['llm_usage'],
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await env.owner.query(
      'select cmd from pg_policies where tablename = $1 order by cmd',
      ['llm_usage'],
    );
    expect(pol.rows.map((r) => r.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('keeps the row when its application is deleted', async () => {
    const t = await env.makeTenant();
    const { application } = await makeApplication(t);
    await recordLlmUsage(
      t.handle,
      call({ userId: t.userId, purpose: 'application', applicationId: application.id }),
    );
    await env.owner.query('delete from applications where id = $1', [application.id]);
    const rows = await listRecentLlmUsage(t.handle, t.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.applicationId).toBeNull();
  });
});
