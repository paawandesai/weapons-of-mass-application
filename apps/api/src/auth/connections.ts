import { sql } from 'drizzle-orm';
import { schema, type TenantHandle } from '@wma/db';
import { GOOGLE_SOURCE_KINDS, SOURCE_SCOPES, sourceStatusFromScopes } from '@wma/google';

/**
 * Writes connected/disconnected rows for gmail, calendar and drive from the granted scopes.
 * Only scope metadata changes: an existing row keeps the rest of its config (for Drive, the
 * selected folder_ids), so a returning sign-in never wipes a selection.
 */
export async function syncGoogleConnections(
  handle: TenantHandle,
  userId: string,
  grantedScopes: string[],
): Promise<void> {
  const ok = sourceStatusFromScopes(grantedScopes);
  const granted = new Set(grantedScopes);
  const { sourceConnections: t } = schema;
  await handle.transaction(async (h) => {
    for (const kind of GOOGLE_SOURCE_KINDS) {
      const connected = ok[kind];
      const missing = SOURCE_SCOPES[kind].filter((s) => !granted.has(s));
      const now = new Date();
      await h.run((tx) =>
        tx
          .insert(t)
          .values({
            tenantId: h.tenantId,
            userId,
            kind,
            status: connected ? 'connected' : 'disconnected',
            config: connected ? {} : { missing_scopes: missing },
            disconnectedAt: connected ? null : now,
          })
          .onConflictDoUpdate({
            target: [t.tenantId, t.userId, t.kind],
            set: connected
              ? {
                  status: 'connected',
                  config: sql`${t.config} - 'missing_scopes'`,
                  connectedAt: now,
                  disconnectedAt: null,
                }
              : {
                  status: 'disconnected',
                  config: sql`${t.config} || ${JSON.stringify({ missing_scopes: missing })}::jsonb`,
                  disconnectedAt: now,
                },
          }),
      );
    }
  });
}
