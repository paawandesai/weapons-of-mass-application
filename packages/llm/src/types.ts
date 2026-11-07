import type { LlmTokenUsage } from '@wma/shared';
import type { z } from 'zod';

export type LlmUsage = LlmTokenUsage;

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
  /**
   * The application this call is made for, for cost attribution only (see `trackLlm`). Never sent
   * to the model.
   */
  applicationId?: string | null;
}

export interface StructuredResponse {
  /** Parsed JSON from the model, not yet validated against the request schema. */
  output: unknown;
  usage: LlmUsage;
  stopReason?: string | null;
  /** The model id the API reports (what was billed); absent from test doubles. */
  model?: string;
}

/** The port the rest of the system codes against. Tests use FakeLlm. */
export interface StructuredLlm {
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse>;
}
