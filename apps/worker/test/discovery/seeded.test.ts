import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adaptersFor, createSeededAdapter, defaultAdapters } from '../../src/discovery/adapters';
import { selectAdapter } from '../../src/submission/adapters';
import { setupDemoEnv, type DemoEnv } from '../demo/support';
import type { SourceContext } from '../../src/discovery/types';

let env: DemoEnv;
beforeAll(async () => {
  env = await setupDemoEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const ctx = {} as SourceContext;

describe('seeded discovery source', () => {
  it("returns the demo tenant's seeded postings as candidates, with the form urls", async () => {
    const out = await createSeededAdapter(env.handle).fetch(ctx);
    expect(out.status).toBe('ok');
    expect(out.candidates).toHaveLength(12);
    expect(out.candidates.every((c) => c.url.includes('/forms/') && c.ats && c.atsJobId)).toBe(
      true,
    );
  });

  it('is registered for a demo tenant and for no other', async () => {
    const demo = await adaptersFor(env.handle);
    expect(demo.map((a) => a.id)).toEqual(['seeded']);

    const real = await env.makeTenant();
    const plain = await adaptersFor(real.handle);
    expect(plain.map((a) => a.id)).toEqual(defaultAdapters().map((a) => a.id));
    expect(plain.map((a) => a.id)).not.toContain('seeded');
    // Even called directly it only ever sees its own tenant's rows.
    expect((await createSeededAdapter(real.handle).fetch(ctx)).candidates).toEqual([]);
  });
});

describe('submission routing for the fixture forms', () => {
  const env4 = { DEMO_FORMS_PORT: '4310' } as NodeJS.ProcessEnv;

  it('maps forms-server urls to the vendor adapter in demo mode', () => {
    for (const vendor of ['greenhouse', 'lever', 'ashby'] as const) {
      const sel = selectAdapter(`http://127.0.0.1:4310/forms/${vendor}/some-job`, env4);
      expect(sel.ok && sel.adapter.ats).toBe(vendor);
    }
    const custom = selectAdapter('https://forms.demo.test/forms/lever/x?captcha', {
      DEMO_FORMS_ORIGIN: 'https://forms.demo.test',
    } as NodeJS.ProcessEnv);
    expect(custom.ok && custom.adapter.ats).toBe('lever');
  });

  it('routes nothing without demo mode, on another origin or another path', () => {
    expect(
      selectAdapter('http://127.0.0.1:4310/forms/greenhouse/x', {} as NodeJS.ProcessEnv),
    ).toEqual({
      ok: false,
      reason: 'unsupported-ats',
    });
    expect(selectAdapter('http://127.0.0.1:4311/forms/greenhouse/x', env4).ok).toBe(false);
    expect(selectAdapter('http://evil.test/forms/greenhouse/x', env4).ok).toBe(false);
    expect(selectAdapter('http://127.0.0.1:4310/other/greenhouse/x', env4).ok).toBe(false);
    expect(selectAdapter('http://127.0.0.1:4310/forms/workday/x', env4).ok).toBe(false);
  });
});
