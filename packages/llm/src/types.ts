import type { z } from 'zod';

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

/** An image sent with the user message (for example a CAPTCHA challenge). */
export interface StructuredImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64, no data-URI prefix. */
  data: string;
}

export interface StructuredRequest<T = unknown> {
  /** Prompt id, e.g. `profile-build/v1`; recorded with the call for tracing and fixtures. */
  prompt: string;
  system: string;
  user: string;
  /** Images placed before the user text. */
  images?: StructuredImage[];
  /** The output must conform to this schema; its JSON schema is sent as the output format. */
  schema: z.ZodType<T>;
  maxTokens?: number;
  /**
   * Marks the end of `system` as a prompt-cache breakpoint. Use when `system` is the stable prefix
   * (instructions plus a profile) and only `user` varies between calls.
   */
  cacheSystem?: boolean;
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
