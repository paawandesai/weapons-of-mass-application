import { and, eq, inArray } from 'drizzle-orm';
import { google } from 'googleapis';
import { activity, schema, vault, type TenantHandle } from '@wma/db';
import { GOOGLE_SOURCE_KINDS, googleConfig } from './config';

export const REFRESH_TOKEN_REF = 'google';

export class GoogleNotConnectedError extends Error {
  readonly code = 'google_not_connected' as const;
  constructor() {
    super('no Google refresh token is stored for this user');
    this.name = 'GoogleNotConnectedError';
  }
}

export class GoogleRevokedError extends Error {
  readonly code = 'google_revoked' as const;
  constructor() {
    super('Google access was revoked; the user must reconnect');
    this.name = 'GoogleRevokedError';
  }
}

export type GoogleAuth = InstanceType<typeof google.auth.OAuth2>;

/** An OAuth2 client authorized from the vaulted refresh token. Access tokens live in memory only. */
export async function getGoogleAuth(handle: TenantHandle, userId: string): Promise<GoogleAuth> {
  const r = await vault.get(handle, userId, 'google_refresh_token', REFRESH_TOKEN_REF);
  if (!r.ok) throw new GoogleNotConnectedError();
  const cfg = googleConfig();
  const auth = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  auth.setCredentials({ refresh_token: r.value });
  return auth;
}

export async function getDriveClient(handle: TenantHandle, userId: string) {
  return google.drive({ version: 'v3', auth: await getGoogleAuth(handle, userId) });
}

export async function getGmailClient(handle: TenantHandle, userId: string) {
  return google.gmail({ version: 'v1', auth: await getGoogleAuth(handle, userId) });
}

export async function getCalendarClient(handle: TenantHandle, userId: string) {
  return google.calendar({ version: 'v3', auth: await getGoogleAuth(handle, userId) });
}

/** True for the error Google returns when a refresh token is revoked, expired or otherwise dead. */
export function isInvalidGrant(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as {
    message?: unknown;
    code?: unknown;
    response?: { data?: { error?: unknown } };
    cause?: unknown;
  };
  if (err.response?.data?.error === 'invalid_grant') return true;
  if (typeof err.message === 'string' && err.message.includes('invalid_grant')) return true;
  return err.cause ? isInvalidGrant(err.cause) : false;
}

/** Marks gmail, calendar and drive disconnected and writes one `google_token_revoked` entry. */
export async function markRevoked(handle: TenantHandle, userId: string): Promise<void> {
  await handle.transaction(async (h) => {
    const { sourceConnections } = schema;
    const updated = await h.run((tx) =>
      tx
        .update(sourceConnections)
        .set({ status: 'disconnected', disconnectedAt: new Date() })
        .where(
          and(
            eq(sourceConnections.tenantId, h.tenantId),
            eq(sourceConnections.userId, userId),
            inArray(sourceConnections.kind, GOOGLE_SOURCE_KINDS),
          ),
        )
        .returning({ kind: sourceConnections.kind }),
    );
    await activity.logActivity(h, {
      userId,
      actor: 'agent',
      action: 'google_token_revoked',
      detail: { disconnected: updated.map((u) => u.kind).sort() },
    });
  });
}

/** Runs `fn`; an `invalid_grant` anywhere inside marks the sources revoked and throws GoogleRevokedError. */
export async function withGoogle<T>(
  handle: TenantHandle,
  userId: string,
  fn: (auth: GoogleAuth) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await getGoogleAuth(handle, userId));
  } catch (e) {
    if (isInvalidGrant(e)) {
      await markRevoked(handle, userId);
      throw new GoogleRevokedError();
    }
    throw e;
  }
}
