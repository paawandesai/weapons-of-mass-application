import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A tenant-bound handle. Every `run` executes inside a transaction whose first statement is
 * `set local app.tenant_id`, so Postgres row-level security applies to everything it does.
 */
export interface TenantHandle {
  readonly tenantId: string;
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Run several repository calls in one transaction (one `set local`). */
  transaction<T>(fn: (handle: TenantHandle) => Promise<T>): Promise<T>;
}

export interface SessionIdentity {
  tenantId: string;
  userId: string;
  expiresAt: Date;
}

export interface Db {
  readonly pool: pg.Pool;
  forTenant(tenantId: string): TenantHandle;
  /** Creates a tenant row and returns its id (the insert itself runs under the new tenant's policy). */
  createTenant(): Promise<string>;
  /** Pre-tenant lookup of a session id (the only way to learn a tenant from a cookie). */
  resolveSession(sessionId: string): Promise<SessionIdentity | null>;
  /** Pre-tenant lookup of a user by Google subject only (never by email), for sign-in. */
  findUserIdentity(googleSub: string): Promise<{ tenantId: string; userId: string } | null>;
  /** Pre-tenant check whether a user with this email already exists (account conflict). */
  emailExists(email: string): Promise<boolean>;
  close(): Promise<void>;
}

async function setTenant(tx: Tx, tenantId: string): Promise<void> {
  // `SET LOCAL` cannot take bind parameters; the id is validated as a uuid above.
  await tx.execute(sql.raw(`set local app.tenant_id = '${tenantId}'`));
}

function makeHandle(db: Database, tenantId: string): TenantHandle {
  return {
    tenantId,
    run: (fn) =>
      db.transaction(async (tx) => {
        await setTenant(tx, tenantId);
        return fn(tx);
      }),
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await setTenant(tx, tenantId);
        return fn(makeInTxHandle(tx, tenantId));
      }),
  };
}

function makeInTxHandle(tx: Tx, tenantId: string): TenantHandle {
  const self: TenantHandle = {
    tenantId,
    run: (fn) => fn(tx),
    transaction: (fn) => tx.transaction(async (inner) => fn(makeInTxHandle(inner as Tx, tenantId))),
  };
  return self;
}

/** `url` must connect as the non-owner application role (wma_app) for RLS to apply. */
export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const forTenant = (tenantId: string): TenantHandle => {
    if (!UUID_RE.test(tenantId)) throw new TypeError('forTenant: tenantId must be a uuid');
    return makeHandle(db, tenantId.toLowerCase());
  };
  return {
    pool,
    forTenant,
    async createTenant() {
      const id = randomUUID();
      await forTenant(id).run((tx) => tx.insert(schema.tenants).values({ id }));
      return id;
    },
    async resolveSession(sessionId) {
      const r = await pool.query<{ tenant_id: string; user_id: string; expires_at: Date }>(
        'select * from wma_resolve_session($1)',
        [sessionId],
      );
      const row = r.rows[0];
      return row
        ? { tenantId: row.tenant_id, userId: row.user_id, expiresAt: row.expires_at }
        : null;
    },
    async findUserIdentity(googleSub) {
      const r = await pool.query<{ tenant_id: string; user_id: string }>(
        'select * from wma_find_user_by_sub($1)',
        [googleSub],
      );
      const row = r.rows[0];
      return row ? { tenantId: row.tenant_id, userId: row.user_id } : null;
    },
    async emailExists(email) {
      const r = await pool.query<{ exists: boolean }>('select wma_email_exists($1) as exists', [
        email,
      ]);
      return r.rows[0]?.exists === true;
    },
    close: () => pool.end(),
  };
}
