import type { LlmUsage, StructuredLlm, StructuredRequest, StructuredResponse } from './types';

/** Zero usage: tests never pay. Tests of the ledger inject their own numbers through a responder. */
const FAKE_USAGE: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export type FakeResponder = unknown | ((request: StructuredRequest) => unknown);

/**
 * Test double that replays recorded responses in order (the last one repeats). A response may be
 * a function of the request. Throw an Error instance to simulate a transport failure.
 */
export class FakeLlm implements StructuredLlm {
  readonly model = 'fake-llm';
  readonly calls: StructuredRequest[] = [];
  private i = 0;

  constructor(private readonly responses: FakeResponder[]) {
    if (responses.length === 0) throw new Error('FakeLlm needs at least one response');
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse> {
    this.calls.push(request as StructuredRequest);
    const r = this.responses[Math.min(this.i++, this.responses.length - 1)];
    const value =
      typeof r === 'function'
        ? (r as (q: StructuredRequest) => unknown)(request as StructuredRequest)
        : r;
    if (value instanceof Error) throw value;
    return { output: value, usage: FAKE_USAGE, stopReason: 'end_turn' };
  }
}
