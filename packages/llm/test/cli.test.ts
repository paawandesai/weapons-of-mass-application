import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCliLlm, createLlmClient, parseBackend, type CliRunInput } from '../src';

const schema = z.object({ a: z.number(), note: z.string().nullable() });
const req = { prompt: 't/v1', system: 'SYS', user: 'USER', schema };

function runner(stdout: string, seen: CliRunInput[] = [], code = 0) {
  return async (i: CliRunInput) => {
    seen.push(i);
    return { stdout, stderr: '', code };
  };
}

describe('parseBackend', () => {
  it('defaults to anthropic and rejects unknown names', () => {
    expect(parseBackend(undefined)).toBe('anthropic');
    expect(parseBackend('Claude-Code')).toBe('claude-code');
    expect(() => parseBackend('bard')).toThrow(/LLM_BACKEND/);
  });
});

describe('createLlmClient dispatch', () => {
  it('builds a CLI backend without an API key', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(createLlmClient({ backend: 'claude-code' }).model).toBe('claude-code');
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('claude-code backend', () => {
  const out = JSON.stringify({
    structured_output: { a: 1 },
    result: '{"a":1}',
    stop_reason: 'end_turn',
    is_error: false,
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 },
    modelUsage: { 'claude-sonnet-5-5': {} },
  });

  it('passes the schema and system prompt, strips API keys, restores nulls, maps usage', async () => {
    const seen: CliRunInput[] = [];
    const llm = createCliLlm('claude-code', {
      run: runner(out, seen),
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't' },
    });
    const res = await llm.generateStructured(req);
    expect(res.output).toEqual({ a: 1, note: null });
    expect(res.usage).toMatchObject({
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: 5,
    });
    expect(res.model).toBe('claude-sonnet-5-5');
    const call = seen[0]!;
    expect(call.command).toBe('claude');
    expect(call.stdin).toBe('USER');
    expect(call.args).toContain('--json-schema');
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(call.env.PATH).toBe('/bin');
  });

  it('writes images to files and allows only Read', async () => {
    const seen: CliRunInput[] = [];
    const llm = createCliLlm('claude-code', { run: runner(out, seen), env: {} });
    await llm.generateStructured({
      ...req,
      images: [{ mediaType: 'image/png', data: Buffer.from('x').toString('base64') }],
    });
    const call = seen[0]!;
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('Read');
    expect(call.stdin).toMatch(/image-0\.png/);
  });

  it('throws on a CLI error result and on a non-zero exit', async () => {
    const bad = JSON.stringify({ is_error: true, result: 'Not logged in' });
    await expect(
      createCliLlm('claude-code', { run: runner(bad), env: {} }).generateStructured(req),
    ).rejects.toThrow(/Not logged in/);
    await expect(
      createCliLlm('claude-code', { run: runner('', [], 1), env: {} }).generateStructured(req),
    ).rejects.toThrow(/exited 1/);
  });
});

describe('gemini backend', () => {
  it('parses JSON out of a fenced reply', async () => {
    const llm = createCliLlm('gemini', {
      run: runner('```json\n{"a":2,"note":"x"}\n```'),
      env: {},
    });
    expect((await llm.generateStructured(req)).output).toEqual({ a: 2, note: 'x' });
  });

  it('hands unparseable text on so the caller can retry', async () => {
    const llm = createCliLlm('gemini', { run: runner('sorry'), env: {} });
    expect((await llm.generateStructured(req)).output).toBe('sorry');
  });
});

describe('concurrency', () => {
  it('never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const llm = createCliLlm('gemini', {
      concurrency: 2,
      env: {},
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { stdout: '{"a":1,"note":null}', stderr: '', code: 0 };
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => llm.generateStructured(req)));
    expect(peak).toBe(2);
  });
});
