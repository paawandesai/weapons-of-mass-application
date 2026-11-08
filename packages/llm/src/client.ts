import Anthropic from '@anthropic-ai/sdk';
import { createGrokLlm } from './grok';
import { createCliLlm, parseBackend, type LlmBackend } from './cli';
import { outputFormatFor } from './schema';
import type { StructuredLlm, StructuredRequest, StructuredResponse } from './types';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_MAX_TOKENS = 32000;

export interface LlmClient extends StructuredLlm {
  readonly anthropic?: Anthropic;
}

export interface LlmClientOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  model?: string;
  /**
   * Which backend serves the calls. Defaults to process.env.LLM_BACKEND, then `anthropic` (API
   * key, billed per token). The others drive a locally installed, logged-in CLI, so the calls
   * count against that subscription instead. See `cli.ts`.
   */
  backend?: LlmBackend;
}

/** Picks the backend (`LLM_BACKEND`) and builds it. Makes no network calls. */
export function createLlmClient(options: LlmClientOptions = {}): LlmClient {
  const backend = options.backend ?? parseBackend(process.env.LLM_BACKEND);
  if (backend === 'anthropic') return createAnthropicClient(options);
  if (backend === 'grok') {
    return createGrokLlm({ apiKey: options.apiKey, model: options.model ?? process.env.LLM_MODEL });
  }
  return createCliLlm(backend, { model: options.model ?? process.env.LLM_MODEL });
}

/** Builds the Anthropic API client wrapper (pay per token). Makes no network calls. */
export function createAnthropicClient(options: LlmClientOptions = {}): LlmClient {
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
        system: req.cacheSystem
          ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
          : req.system,
        messages: [
          {
            role: 'user',
            content: req.images?.length
              ? [
                  ...req.images.map((img) => ({
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: img.mediaType,
                      data: img.data,
                    },
                  })),
                  { type: 'text' as const, text: req.user },
                ]
              : req.user,
          },
        ],
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
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
        },
        stopReason: message.stop_reason,
        model: message.model,
      };
    },
  };
}
