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
