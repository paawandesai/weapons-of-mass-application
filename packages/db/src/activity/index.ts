import { and, desc, eq, getTableColumns, lt, or, sql, type SQL } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { activityLog } from '../schema';

/**
 * Position of an entry in the newest-first order. `at` is Postgres's own text rendering of the
 * timestamptz (microsecond precision, which a JavaScript Date cannot hold), `id` breaks ties.
 */
export interface ActivityCursor {
  at: string;
  id: string;
}

export type ActivityEntry = typeof activityLog.$inferSelect & {
  /** Pass as `before` to fetch the entries after this one. */
  cursor: ActivityCursor;
};
export type ActivityActor = 'agent' | 'user';

export interface ActivityInput {
  userId: string;
  applicationId?: string | null;
  actor: ActivityActor;
  action: string;
  detail?: Record<string, unknown>;
}

export interface ListOptions {
  /** Default 50, capped at 200. */
  limit?: number;
  /** Only entries after this one in the newest-first order (the `cursor` of the last entry seen). */
  before?: ActivityCursor;
}

/** Thrown, before anything is written, when a detail object has a secret-looking key. */
export class ActivityRedactionError extends Error {
  readonly code = 'activity_redaction' as const;
  constructor(readonly keyPath: string) {
    super(`activity detail rejected: key "${keyPath}" looks like secret material`);
    this.name = 'ActivityRedactionError';
  }
}

const SECRET_KEY_RE = /token|password|secret/i;

function findSecretKey(value: unknown, path: string, seen: Set<object>): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretKey(value[i], `${path}[${i}]`, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (SECRET_KEY_RE.test(k)) return p;
    const hit = findSecretKey(v, p, seen);
    if (hit) return hit;
  }
  return null;
}

/** Throws `ActivityRedactionError` if any key at any depth matches /token|password|secret/i. */
export function assertRedacted(detail: unknown): void {
  const hit = findSecretKey(detail, '', new Set());
  if (hit) throw new ActivityRedactionError(hit);
}

export async function logActivity(handle: TenantHandle, input: ActivityInput): Promise<void> {
  const detail = input.detail ?? {};
  assertRedacted(detail);
  await handle.run((tx) =>
    tx.insert(activityLog).values({
      tenantId: handle.tenantId,
      userId: input.userId,
      applicationId: input.applicationId ?? null,
      // clock_timestamp so entries written in one transaction still order correctly.
      at: sql`clock_timestamp()`,
      actor: input.actor,
      action: input.action,
      detail,
    }),
  );
}

function clampLimit(limit: number | undefined): number {
  const n = Math.trunc(limit ?? 50);
  return Math.min(Math.max(Number.isFinite(n) ? n : 50, 1), 200);
}

const selection = {
  ...getTableColumns(activityLog),
  atText: sql<string>`${activityLog.at}::text`.as('at_text'),
};

/** Rows ordered by (at desc, id desc) strictly after the cursor, compared at full precision. */
function afterCursor(cursor: ActivityCursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const at = sql`${cursor.at}::timestamptz`;
  return or(
    lt(activityLog.at, at),
    and(sql`${activityLog.at} = ${at}`, lt(activityLog.id, cursor.id)),
  );
}

async function list(
  handle: TenantHandle,
  scope: SQL | undefined,
  opts: ListOptions,
): Promise<ActivityEntry[]> {
  const rows = await handle.run((tx) =>
    tx
      .select(selection)
      .from(activityLog)
      .where(and(eq(activityLog.tenantId, handle.tenantId), scope, afterCursor(opts.before)))
      .orderBy(desc(activityLog.at), desc(activityLog.id))
      .limit(clampLimit(opts.limit)),
  );
  return rows.map(({ atText, ...row }) => ({ ...row, cursor: { at: atText, id: row.id } }));
}

export function listByUser(
  handle: TenantHandle,
  userId: string,
  opts: ListOptions = {},
): Promise<ActivityEntry[]> {
  return list(handle, eq(activityLog.userId, userId), opts);
}

export function listByApplication(
  handle: TenantHandle,
  applicationId: string,
  opts: ListOptions = {},
): Promise<ActivityEntry[]> {
  return list(handle, eq(activityLog.applicationId, applicationId), opts);
}
