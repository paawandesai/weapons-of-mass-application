import { outputFormatFor } from './schema';
import type { LlmUsage, StructuredLlm, StructuredRequest, StructuredResponse } from './types';
import { extractJson } from './cli';

export const DEFAULT_GROK_MODEL = 'grok-4';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

export interface GrokLlmOptions {
  /** Defaults to process.env.XAI_API_KEY. */
  apiKey?: string;
  /** Defaults to LLM_MODEL, then `grok-4`. */
  model?: string;
  /** Defaults to process.env.XAI_BASE_URL, then https://api.x.ai/v1. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * xAI Grok over its OpenAI-compatible chat API. Billed per token on XAI_API_KEY (there is no
 * subscription login for it). The schema goes in the prompt with JSON mode on, and the caller's
 * zod validation and retry loop handle a reply that does not match.
 */
export function createGrokLlm(options: GrokLlmOptions = {}): StructuredLlm {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('llm: XAI_API_KEY is not set');
  const model = options.model || DEFAULT_GROK_MODEL;
  const baseUrl = (options.baseUrl ?? process.env.XAI_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;

  return {
    model,
    async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse> {
      const format = outputFormatFor(req.schema);
      const instruction =
        'Reply with one JSON object only, no prose and no code fence, matching this JSON Schema:\n' +
        JSON.stringify(format.wire);
      const userContent = req.images?.length
        ? [
            ...req.images.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            })),
            { type: 'text' as const, text: req.user },
          ]
        : req.user;
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${req.system}\n\n${instruction}` },
            { role: 'user', content: userContent },
          ],
        }),
      });
      const text = await res.text();
      let body: ChatResponse;
      try {
        body = JSON.parse(text) as ChatResponse;
      } catch {
        throw new Error(`llm: grok returned ${res.status} with a non-JSON body`);
      }
      if (!res.ok) {
        throw new Error(`llm: grok ${res.status}: ${body.error?.message ?? text.slice(0, 300)}`);
      }
      const choice = body.choices?.[0];
      const content = choice?.message?.content ?? '';
      let output: unknown;
      try {
        output = format.restore(extractJson(content));
      } catch {
        // Truncated or malformed JSON: hand the raw text on so validation fails and retries.
        output = content;
      }
      const cached = num(body.usage?.prompt_tokens_details?.cached_tokens);
      const usage: LlmUsage = {
        input_tokens: Math.max(0, num(body.usage?.prompt_tokens) - cached),
        output_tokens: num(body.usage?.completion_tokens),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cached,
      };
      return {
        output,
        usage,
        stopReason: choice?.finish_reason ?? null,
        model: body.model ?? model,
      };
    },
  };
}
