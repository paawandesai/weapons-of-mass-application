import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGrokLlm, createLlmClient, parseBackend } from '../src';

const schema = z.object({ a: z.number(), note: z.string().nullable() });
const req = { prompt: 't/v1', system: 'SYS', user: 'USER', schema };

function fakeFetch(
  body: unknown,
  status = 200,
  seen: Array<{ url: string; init: RequestInit }> = [],
) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe('grok backend', () => {
  it('is selected by name and needs an XAI_API_KEY', () => {
    expect(parseBackend('Grok')).toBe('grok');
    const saved = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      expect(() => createLlmClient({ backend: 'grok' })).toThrow(/XAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.XAI_API_KEY = saved;
    }
  });

  it('posts the schema in JSON mode, restores nulls and maps usage', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const llm = createGrokLlm({
      apiKey: 'k',
      fetch: fakeFetch(
        {
          model: 'grok-4-0709',
          choices: [{ message: { content: '```json\n{"a":1}\n```' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        },
        200,
        seen,
      ),
    });
    const res = await llm.generateStructured(req);
    expect(res.output).toEqual({ a: 1, note: null });
    expect(res.usage).toEqual({
      input_tokens: 60,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 40,
    });
    expect(res.model).toBe('grok-4-0709');
    const sent = JSON.parse(seen[0]!.init.body as string);
    expect(seen[0]!.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.messages[0].content).toMatch(/^SYS[\s\S]*JSON Schema/);
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('sends images as data URLs', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const llm = createGrokLlm({
      apiKey: 'k',
      fetch: fakeFetch({ choices: [{ message: { content: '{"a":1}' } }] }, 200, seen),
    });
    await llm.generateStructured({
      ...req,
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    });
    const content = JSON.parse(seen[0]!.init.body as string).messages[1].content;
    expect(content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('throws on an API error and hands malformed text on for a retry', async () => {
    await expect(
      createGrokLlm({
        apiKey: 'k',
        fetch: fakeFetch({ error: { message: 'bad key' } }, 401),
      }).generateStructured(req),
    ).rejects.toThrow(/401: bad key/);
    const res = await createGrokLlm({
      apiKey: 'k',
      fetch: fakeFetch({ choices: [{ message: { content: 'sorry' } }] }),
    }).generateStructured(req);
    expect(res.output).toBe('sorry');
  });
});
