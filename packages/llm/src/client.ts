import Anthropic from '@anthropic-ai/sdk';
import { outputFormatFor } from './schema';
import type { StructuredLlm, StructuredRequest, StructuredResponse } from './types';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_MAX_TOKENS = 32000;

export interface LlmClient extends StructuredLlm {
  readonly anthropic: Anthropic;
}

export interface LlmClientOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  model?: string;
}

/** Builds the Anthropic client wrapper. Makes no network calls. */
export function createLlmClient(options: LlmClientOptions = {}): LlmClient {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('llm: ANTHROPIC_API_KEY is not set');
  const model = options.model ?? DEFAULT_MODEL;
  const anthropic = new Anthropic({ apiKey });
  return {
    model,
    anthropic,
    async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse> {
      // Adaptive thinking, streamed (long outputs), structured output against the zod schema.
      const format = outputFormatFor(req.schema);
      const stream = anthropic.messages.stream({
        model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        thinking: { type: 'adaptive' },
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: { type: 'json_schema', schema: format.wire } },
      });
      const message = await stream.finalMessage();
      const text = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      let output: unknown;
      try {
        output = format.restore(JSON.parse(text));
      } catch {
        // Truncated or malformed JSON: hand the raw text on so schema validation fails and retries.
        output = text;
      }
      return {
        output,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        },
        stopReason: message.stop_reason,
      };
    },
  };
}
