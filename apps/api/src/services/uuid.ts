const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Structurally complete UUID (8-4-4-4-12 hex groups); anything else would be rejected by Postgres. */
export const isUuid = (s: string): boolean => UUID_RE.test(s);
