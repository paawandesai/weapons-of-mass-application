import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { getUserById, schema } from '@wma/db';
import type { MeResponse } from '@wma/shared';
import type { AppEnv } from '../middleware/session';
import { toListedConnection } from '../services/connections';

export const meRoutes = new Hono<AppEnv>();

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

meRoutes.get('/', async (c) => {
  const { handle, userId } = c.get('session');
  const user = await getUserById(handle, userId);
  const { sourceConnections: t } = schema;
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(t)
      .where(and(eq(t.tenantId, handle.tenantId), eq(t.userId, userId)))
      .orderBy(t.kind),
  );
  const body: MeResponse = {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      approved_profile_version: user.approvedProfileVersion,
      approved_profile_at: iso(user.approvedProfileAt),
      daily_target: user.dailyTarget,
      digest_hour: user.digestHour,
    },
    connections: rows.map(toListedConnection),
  };
  return c.json(body);
});
