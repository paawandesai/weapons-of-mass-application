import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeLlm } from '@wma/llm';
import { callStructured, coerceStructuredOutput } from '../../src/submission/structured';

describe('coerceStructuredOutput', () => {
  const obj = {
    answer: 'Built a co-pilot.',
    grounded: true,
    unanswerable: false,
    ungrounded_claims: [],
  };

  it('parses a raw JSON string, including a fenced block', () => {
    expect(coerceStructuredOutput(obj)).toEqual(obj);
    expect(coerceStructuredOutput(JSON.stringify(obj))).toEqual(obj);
    expect(coerceStructuredOutput('```json\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
  });

  it('extracts an object from surrounding text', () => {
    expect(coerceStructuredOutput('Here you go: ' + JSON.stringify(obj) + ' thanks')).toEqual(obj);
  });

  it('leaves a non-JSON string alone so the caller can retry', () => {
    expect(coerceStructuredOutput('just a string')).toBe('just a string');
  });
});

describe('callStructured', () => {
  const schema = z.object({
    answer: z.string(),
    grounded: z.boolean(),
    unanswerable: z.boolean(),
    ungrounded_claims: z.array(z.string()),
  });

  it('accepts a first reply that is a JSON string instead of an object', async () => {
    const payload = {
      answer: 'A clinical co-pilot for clinicians.',
      grounded: true,
      unanswerable: false,
      ungrounded_claims: [],
    };
    const llm = new FakeLlm([JSON.stringify(payload)]);
    const out = await callStructured(llm, 'answer-form-question', 'q', schema);
    expect(out).toEqual(payload);
  });
});
