import { loadPrompt, type StructuredLlm } from '@wma/llm';
import type { z } from 'zod';

export class StructuredOutputError extends Error {
  constructor(
    readonly prompt: string,
    readonly issue: string,
  ) {
    super(`${prompt}: model output rejected: ${issue}`);
    this.name = 'StructuredOutputError';
  }
}

/**
 * One structured call against a versioned prompt file (`<name>/v1`): the reply is validated with
 * the schema, and an invalid reply gets exactly one retry that quotes the issue. Transport errors
 * propagate unchanged.
 */

/** Turns a model reply that should have been an object into one, when it is JSON (possibly fenced). */
export function coerceStructuredOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  let text = output.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // leave the string so schema validation can reject and retry
      }
    }
  }
  return output;
}

export async function callStructured<T>(
  llm: StructuredLlm,
  name: string,
  user: string,
  schema: z.ZodType<T>,
  maxTokens?: number,
): Promise<T> {
  const prompt = `${name}/v1`;
  const system = loadPrompt(name, 'v1');
  let issue = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.generateStructured({
      prompt,
      system,
      user:
        attempt === 0
          ? user
          : `${user}\n\nYour previous reply was rejected: ${issue}. Reply again with a valid object.`,
      schema,
      maxTokens,
    });
    const parsed = schema.safeParse(coerceStructuredOutput(res.output));
    if (parsed.success) return parsed.data;
    issue = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
  }
  throw new StructuredOutputError(prompt, issue);
}

export const esc = (s: string): string => s.replace(/<\/(\w+)>/g, '<\\/$1>');
