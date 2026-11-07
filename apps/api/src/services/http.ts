import type { Context } from 'hono';
import type { ZodError } from 'zod';

export function validationError(c: Context, error: ZodError) {
  return c.json(
    {
      code: 'validation',
      message: 'Invalid request',
      issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
    },
    400,
  );
}

export const badRequest = (c: Context, code: string, message: string) =>
  c.json({ code, message }, 400);

export const invalidJson = (c: Context) =>
  c.json(
    {
      code: 'validation',
      message: 'Invalid request',
      issues: [{ path: [], message: 'body must be JSON' }],
    },
    400,
  );

/** Parses a JSON body; returns undefined on malformed JSON. */
export async function readJson(c: Context): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
