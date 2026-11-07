import { loadEnv } from '@wma/db';
import { createLlmClient, type StructuredLlm } from '@wma/llm';
import { describe, expect, it } from 'vitest';
import { tailorResume } from '../../src/submission/tailor';
import { makeCtx } from '../fixtures/submission';

loadEnv();

/** Real-API smoke: RUN_LLM_SMOKE=1 pnpm -F @wma/worker exec vitest run test/submission/tailor.smoke.test.ts */
describe.skipIf(process.env.RUN_LLM_SMOKE !== '1')('tailor smoke (real API)', () => {
  it('tailors the fixture profile and passes the truthfulness check', async () => {
    const real = createLlmClient();
    const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
    const counting: StructuredLlm = {
      model: real.model,
      async generateStructured(req) {
        const res = await real.generateStructured(req);
        usage.input_tokens += res.usage.input_tokens;
        usage.output_tokens += res.usage.output_tokens;
        usage.calls += 1;
        return res;
      },
    };
    const ctx = makeCtx(counting);
    const r = await tailorResume(ctx);
    console.log('SMOKE usage', JSON.stringify(usage), 'result', JSON.stringify(r));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pageCount).toBeLessThanOrEqual(2);
  }, 300_000);
});
