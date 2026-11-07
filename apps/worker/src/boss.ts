import { PgBoss } from 'pg-boss';

/** Creates the queue client. Handlers are registered by later changes. */
export function createBoss(connectionString: string): PgBoss {
  return new PgBoss(connectionString);
}
