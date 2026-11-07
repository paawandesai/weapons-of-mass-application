import { describe, expect, it } from 'vitest';
import { loadEnv } from '@wma/db';
import { createLlmClient, type StructuredLlm } from '@wma/llm';
import { greenhouseAdapter } from '../../src/discovery/adapters/greenhouse';
import { leverAdapter } from '../../src/discovery/adapters/lever';
import { judgeAll } from '../../src/discovery/judge';
import { boardRefs, createWorld, fastHttp, NOW, profile, TODAY } from './support';

loadEnv();

/**
 * Real-API smoke: RUN_LLM_SMOKE=1 pnpm -F @wma/worker exec vitest run test/discovery/judge.smoke.test.ts
 * Judges three fixture postings (the fixture boards are served from msw; only the model call is real).
 */
describe.skipIf(process.env.RUN_LLM_SMOKE !== '1')('apply-decision against the real model', () => {
  it('returns schema-valid judgments for three fixture postings', async () => {
    const w = createWorld();
    w.server.listen({ onUnhandledRequest: 'bypass' });
    try {
      const ctx = { http: fastHttp(), boards: boardRefs, profile, now: NOW };
      const [gh, lv] = await Promise.all([greenhouseAdapter.fetch(ctx), leverAdapter.fetch(ctx)]);
      const postings = [gh.candidates[0]!, lv.candidates[0]!, gh.candidates[1]!];
      const real = createLlmClient();
      const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
      const llm: StructuredLlm = {
        model: real.model,
        async generateStructured(req) {
          const res = await real.generateStructured(req);
          usage.input_tokens += res.usage.input_tokens;
          usage.output_tokens += res.usage.output_tokens;
          usage.calls++;
          return res;
        },
      };
      const started = Date.now();
      const results = await judgeAll(postings, { llm, profile, today: TODAY });
      const ms = Date.now() - started;
      console.log(
        JSON.stringify(
          {
            model: real.model,
            ms,
            usage,
            results: results.map((r) => ({
              title: r.candidate.title,
              status: r.status,
              judgment: r.status === 'judged' ? r.judgment : null,
            })),
          },
          null,
          1,
        ),
      );
      expect(results.every((r) => r.status === 'judged')).toBe(true);
      for (const r of results)
        if (r.status === 'judged') expect(r.judgment.rationale.length).toBeLessThanOrEqual(600);
      // the sales role is not a match for a senior backend engineer
      const sales = results.find((r) => r.candidate.title === 'Account Executive');
      expect(sales?.status === 'judged' && sales.judgment.apply).toBe(false);
    } finally {
      w.server.close();
    }
  }, 180000);
});
