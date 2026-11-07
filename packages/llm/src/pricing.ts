import type { LlmTokenUsage } from '@wma/shared';

/** USD per million tokens. Cache write is the 5-minute ephemeral rate (1.25x input). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Anthropic first-party list prices as of 2026-10. Keyed by the exact model id the API reports.
 * A model missing here is recorded with its tokens and a null cost, never a guessed one.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const PER_TOKEN = 1 / 1_000_000;

/** Price for a model id, tolerating a date suffix (`claude-opus-5-5-20260401`). */
export function priceFor(model: string): ModelPrice | null {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const stem = model.replace(/-\d{8}$/, '');
  return MODEL_PRICES[stem] ?? null;
}

/** Estimated cost of one call in USD, or null when the model has no known price. */
export function estimateCostUsd(model: string, usage: LlmTokenUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const usd =
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    usage.cache_creation_input_tokens * p.cacheWrite +
    usage.cache_read_input_tokens * p.cacheRead;
  // Round to a tenth of a cent's thousandth: enough for sub-cent calls, stable in tests.
  return Math.round(usd * PER_TOKEN * 1e8) / 1e8;
}
