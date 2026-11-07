import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { touchSession, type Db, type TenantHandle } from '@wma/db';

export const SESSION_COOKIE = 'wma_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionContext {
  sessionId: string;
  handle: TenantHandle;
  userId: string;
  tenantId: string;
}

export type AppEnv = {
  Variables: { db: Db; session: SessionContext; now: () => Date };
};

export const isProduction = () => process.env.NODE_ENV === 'production';

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction(),
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isProduction() });
}

export const unauthenticated = (c: Context) =>
  c.json({ code: 'unauthenticated', message: 'Sign in required' }, 401);

/**
 * Resolves the session cookie to {handle, userId, tenantId}. Unknown, signed-out and expired
 * sessions are 401. Expiry slides 30 days from use, written at most once per hour.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return unauthenticated(c);
  const db = c.get('db');
  const now = c.get('now')();
  const found = await db.resolveSession(id);
  if (!found) {
    clearSessionCookie(c);
    return unauthenticated(c);
  }
  const handle = db.forTenant(found.tenantId);
  if (found.expiresAt.getTime() <= now.getTime()) {
    clearSessionCookie(c);
    return unauthenticated(c);
  }
  const idleMs = SESSION_TTL_MS - (found.expiresAt.getTime() - now.getTime());
  if (idleMs >= TOUCH_INTERVAL_MS) {
    await touchSession(handle, id, new Date(now.getTime() + SESSION_TTL_MS));
    setSessionCookie(c, id);
  }
  c.set('session', { sessionId: id, handle, userId: found.userId, tenantId: found.tenantId });
  await next();
};
