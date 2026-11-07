import type { Db } from '@wma/db';

/**
 * Startup check (design rule 11): at most one tenant may carry the demo flag. Logs an error when
 * more than one does and returns the count; it never throws and never stops the server.
 */
export async function checkDemoTenants(
  db: Pick<Db, 'demoTenantCount'>,
  log: (message: string) => void = (m) => console.error(m),
): Promise<number | null> {
  try {
    const n = await db.demoTenantCount();
    if (n > 1) {
      log(`demo flag misconfigured: ${n} tenants have demo = true, expected at most 1`);
    }
    return n;
  } catch (e) {
    log(`demo flag check failed: ${e instanceof Error ? e.name : 'unknown error'}`);
    return null;
  }
}
