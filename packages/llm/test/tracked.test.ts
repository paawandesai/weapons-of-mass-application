import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LlmCallRecord } from '@wma/shared';
import { estimateCostUsd, FakeLlm, priceFor, trackLlm, type StructuredLlm } from '../src';

const schema = z.object({ ok: z.boolean() });
const req = (over: Record<string, unknown> = {}) => ({
  prompt: 'apply-decision/v1',
  system: 's',
  user: 'u',
  schema,
  ...over,
});

describe('pricing', () => {
  it('prices the default model from the table, cache tokens at their own rates', () => {
    expect(priceFor('claude-opus-5-5')).toEqual({
      input: 4,
      output: 20,
      cacheWrite: 5,
      cacheRead: 0.2,
    });
    expect(
      estimateCostUsd('claude-opus-5-5', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      }),
    ).toBe(29.2);
    expect(
      estimateCostUsd('claude-opus-5-5', {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBe(0.014);
  });

  it('tolerates a date suffix and returns null for an unknown model', () => {
    expect(priceFor('claude-opus-5-5-20260401')).not.toBeNull();
    expect(priceFor('some-other-model')).toBeNull();
    expect(
      estimateCostUsd('some-other-model', {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeNull();
  });
});

describe('trackLlm', () => {
  const usage = {
    input_tokens: 2000,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1500,
  };
  const inner: StructuredLlm = {
    model: 'claude-opus-5-5',
    async generateStructured() {
      return { output: { ok: true }, usage, stopReason: 'end_turn', model: 'claude-opus-5-5' };
    },
  };

  it('records one entry per call with the purpose, prompt, tokens and estimated cost', async () => {
    const records: LlmCallRecord[] = [];
    const llm = trackLlm(inner, async (r) => void records.push(r), { purpose: 'discovery' });
    const res = await llm.generateStructured(req());
    expect(res.output).toEqual({ ok: true });
    expect(llm.model).toBe('claude-opus-5-5');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: 'discovery',
      applicationId: null,
      model: 'claude-opus-5-5',
      prompt: 'apply-decision/v1',
      usage,
      costUsd: 0.0143,
    });
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('attributes to the scope application, and a request application wins', async () => {
    const records: LlmCallRecord[] = [];
    const llm = trackLlm(inner, async (r) => void records.push(r), {
      purpose: 'application',
      applicationId: 'app-scope',
    });
    await llm.generateStructured(req());
    await llm.generateStructured(req({ applicationId: 'app-request' }));
    expect(records.map((r) => r.applicationId)).toEqual(['app-scope', 'app-request']);
  });

  it('falls back to the configured model when the response names none, and prices unknown models as null', async () => {
    const records: LlmCallRecord[] = [];
    const fake = new FakeLlm([{ ok: true }]);
    const llm = trackLlm(fake, async (r) => void records.push(r), { purpose: 'inbox' });
    await llm.generateStructured(req());
    expect(records[0]).toMatchObject({ model: 'fake-llm', costUsd: null });
    expect(fake.calls).toHaveLength(1);
  });

  it('does not record a call that threw, and a failing sink never fails the call', async () => {
    const records: LlmCallRecord[] = [];
    const failing = new FakeLlm([new Error('boom')]);
    const tracked = trackLlm(failing, async (r) => void records.push(r), { purpose: 'inbox' });
    await expect(tracked.generateStructured(req())).rejects.toThrow('boom');
    expect(records).toHaveLength(0);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const llm = trackLlm(
        inner,
        async () => {
          throw new Error('ledger down');
        },
        { purpose: 'inbox' },
      );
      await expect(llm.generateStructured(req())).resolves.toMatchObject({ output: { ok: true } });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
