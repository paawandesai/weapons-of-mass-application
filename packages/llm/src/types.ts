import type { z } from 'zod';

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface StructuredRequest<T = unknown> {
  /** Prompt id, e.g. `profile-build/v1`; recorded with the call for tracing and fixtures. */
  prompt: string;
  system: string;
  user: string;
  /** The output must conform to this schema; its JSON schema is sent as the output format. */
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface StructuredResponse {
  /** Parsed JSON from the model, not yet validated against the request schema. */
  output: unknown;
  usage: LlmUsage;
  stopReason?: string | null;
}

/** The port the rest of the system codes against. Tests use FakeLlm. */
export interface StructuredLlm {
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse>;
}
