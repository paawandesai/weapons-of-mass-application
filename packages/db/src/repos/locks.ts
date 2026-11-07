import { sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';

/**
 * Runs `fn` in one transaction holding a per-user advisory lock (`pg_advisory_xact_lock`), released
 * at commit or rollback. Callers use it to serialize multi-step mutations of one user's state that
 * also touch something outside the database (stored files).
 */
export function withUserLock<T>(
  handle: TenantHandle,
  userId: string,
  fn: (handle: TenantHandle) => Promise<T>,
): Promise<T> {
  return handle.transaction(async (h) => {
    await h.run((tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`));
    return fn(h);
  });
}
