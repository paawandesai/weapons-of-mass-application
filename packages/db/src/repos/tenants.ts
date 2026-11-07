import { eq } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { NotFoundError } from '../errors';
import { tenants } from '../schema';

export type Tenant = typeof tenants.$inferSelect;

/** The handle's own tenant row. */
export async function getCurrentTenant(handle: TenantHandle): Promise<Tenant> {
  const rows = await handle.run((tx) =>
    tx.select().from(tenants).where(eq(tenants.id, handle.tenantId)),
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('tenant');
  return row;
}
