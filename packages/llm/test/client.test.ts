import { describe, expect, it } from 'vitest';
import { createLlmClient } from '../src';

describe('createLlmClient', () => {
  it('throws without an API key', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createLlmClient()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('builds a client with the default model', () => {
    expect(createLlmClient({ apiKey: 'test-key' }).model).toBe('claude-opus-5-5');
  });
});

describe('outputFormatFor wire schema', () => {
  it('strips maxItems (rejected by structured outputs) and keeps the array itself', async () => {
    const { z } = await import('zod');
    const { outputJsonSchema } = await import('../src/schema');
    const wire = outputJsonSchema(z.object({ topics: z.array(z.string().min(1)).min(1).max(15) }));
    const topics = (wire.properties as Record<string, Record<string, unknown>>).topics!;
    expect(topics.type).toBe('array');
    expect(topics).not.toHaveProperty('maxItems');
    expect(topics.minItems).toBe(1);
  });
});
