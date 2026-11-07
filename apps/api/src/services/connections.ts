import type { SourceConnectionRow } from '@wma/db';
import type { Connection } from '@wma/shared';

export const PROFILE_SOURCE_KINDS = ['resume', 'linkedin', 'github', 'drive'] as const;
export type ProfileSourceKind = (typeof PROFILE_SOURCE_KINDS)[number];

export const isProfileSourceKind = (k: string): k is ProfileSourceKind =>
  (PROFILE_SOURCE_KINDS as readonly string[]).includes(k);

export function toConnection(row: SourceConnectionRow): Connection {
  return {
    kind: row.kind,
    status: row.status,
    config: (row.config as Record<string, unknown> | null) ?? null,
    connected_at: row.connectedAt.toISOString(),
  };
}

/**
 * Connection as listed by GET /api/me. `config.text` is the cached source text the worker reads;
 * it can be large (up to 200 KB) and the list never needs it.
 */
export function toListedConnection(row: SourceConnectionRow): Connection {
  const config = { ...((row.config as Record<string, unknown> | null) ?? {}) };
  delete config.text;
  return { ...toConnection(row), config };
}

/** Postgres jsonb rejects NUL characters; extracted text can contain them. */
export const cleanText = (s: string, max = 200_000): string =>
  s
    .replaceAll('\u0000', '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, max);
