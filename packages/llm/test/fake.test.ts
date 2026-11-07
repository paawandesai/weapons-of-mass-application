import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { profileModelOutputSchema } from '@wma/shared';
import { FakeLlm, loadPrompt, outputFormatFor, outputJsonSchema } from '../src';

const req = { prompt: 'x/v1', system: 's', user: 'u', schema: z.object({ a: z.number() }) };

describe('FakeLlm', () => {
  it('replays responses in order and repeats the last', async () => {
    const llm = new FakeLlm([{ a: 1 }, { a: 2 }]);
    expect((await llm.generateStructured(req)).output).toEqual({ a: 1 });
    expect((await llm.generateStructured(req)).output).toEqual({ a: 2 });
    expect((await llm.generateStructured(req)).output).toEqual({ a: 2 });
    expect(llm.calls).toHaveLength(3);
  });

  it('throws an Error response to simulate transport failure', async () => {
    const llm = new FakeLlm([new Error('boom')]);
    await expect(llm.generateStructured(req)).rejects.toThrow('boom');
  });

  it('supports responders that read the request', async () => {
    const llm = new FakeLlm([(q: { user: string }) => ({ echo: q.user })]);
    expect((await llm.generateStructured(req)).output).toEqual({ echo: 'u' });
  });
});

describe('prompts and schema', () => {
  it('loads the versioned profile-build prompt', () => {
    expect(loadPrompt('profile-build', 'v1')).toMatch(/Never invent/);
  });

  it('rejects path-like prompt references', () => {
    expect(() => loadPrompt('../x', 'v1')).toThrow();
  });

  it('derives a pattern-free JSON schema with closed objects from the profile model schema', () => {
    const schema = outputJsonSchema(profileModelOutputSchema);
    const text = JSON.stringify(schema);
    expect(text).toContain('work_history');
    expect(text).not.toMatch(/"pattern"|"format"|"minLength"|\$schema/);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('work_history');
  });

  it('wire schema has no nullable unions; restore puts null back and the result validates', () => {
    const wire = JSON.stringify(outputJsonSchema(profileModelOutputSchema));
    expect(wire).not.toContain('"null"');
    const { restore } = outputFormatFor(profileModelOutputSchema);
    const sparse = {
      identity: { full_name: 'A' },
      contact: { email: 'a@example.com' },
      work_history: [{ employer: 'X', title: 'Y', highlights: [], sources: ['resume'] }],
      projects: [],
      skills: [{ name: 'TypeScript' }],
      education: [],
    };
    const filled = restore(sparse) as typeof sparse & { identity: Record<string, unknown> };
    expect(filled.identity.headline).toBeNull();
    expect(profileModelOutputSchema.safeParse(filled).success).toBe(true);
  });
});

describe('profile-build prompt dates', () => {
  it('keeps unknown months unknown instead of inventing them', () => {
    const prompt = loadPrompt('profile-build', 'v1');
    expect(prompt).not.toMatch(/YYYY-01|YYYY-12/);
    expect(prompt).toMatch(/year-only/);
  });
});
