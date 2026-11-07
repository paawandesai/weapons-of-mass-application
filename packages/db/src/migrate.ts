import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Applies pending migrations as the owner role. The application role password is handed to the
 * migration as session setting `wma.app_password`.
 */
export async function runMigrations(opts: { url: string; appPassword?: string }): Promise<void> {
  // One connection, so the session setting is visible to the migration transaction.
  const pool = new pg.Pool({ connectionString: opts.url, max: 1 });
  try {
    await pool.query("select set_config('wma.app_password', $1, false)", [opts.appPassword ?? '']);
    await migrate(drizzle(pool), { migrationsFolder: resolve(import.meta.dirname, '../drizzle') });
  } finally {
    await pool.end();
  }
}
