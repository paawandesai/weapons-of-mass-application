import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, getSignedCookie, setCookie, deleteCookie, setSignedCookie } from 'hono/cookie';
import { activity, createUser, vault } from '@wma/db';
import { buildAuthUrl, exchangeCode, fetchUserInfo, REFRESH_TOKEN_REF } from '@wma/google';
import {
  clearSessionCookie,
  isProduction,
  SESSION_COOKIE,
  setSessionCookie,
  type AppEnv,
} from '../middleware/session';
import { demoAuthRoutes } from './demo';
import { syncGoogleConnections } from './connections';
import { endSession, startSession } from './sessions';

const OAUTH_COOKIE = 'wma_oauth';
const KNOWN_COOKIE = 'wma_known';
const OAUTH_TTL_S = 10 * 60;

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET must be set');
  return s;
}

/**
 * Where the browser lands after the callback. In local dev the API (the registered redirect URI)
 * and the web app run on different ports, so redirects must name the web origin explicitly.
 */
export function webOrigin(): string {
  return (process.env.WEB_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '');
}

const fail = (c: Context, code: string) => c.redirect(`${webOrigin()}/signin?error=${code}`, 302);

export const authRoutes = new Hono<AppEnv>();

authRoutes.route('/demo', demoAuthRoutes);

authRoutes.get('/google/start', async (c) => {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // A refresh token is only issued on consent, so force it for new browsers and explicit reconnects.
  const forceConsent = c.req.query('reconnect') === '1' || !getCookie(c, KNOWN_COOKIE);
  await setSignedCookie(c, OAUTH_COOKIE, JSON.stringify({ state, verifier }), sessionSecret(), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction(),
    path: '/auth/google',
    maxAge: OAUTH_TTL_S,
  });
  return c.redirect(buildAuthUrl({ state, codeChallenge: challenge, forceConsent }), 302);
});

authRoutes.get('/google/callback', async (c) => {
  const raw = await getSignedCookie(c, sessionSecret(), OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/auth/google', secure: isProduction() });
  let saved: { state: string; verifier: string } | null = null;
  try {
    saved = raw ? (JSON.parse(raw) as { state: string; verifier: string }) : null;
  } catch {
    saved = null;
  }
  const q = c.req.query();
  if (q.error === 'access_denied') return fail(c, 'declined');
  if (!saved || !q.state || q.state !== saved.state || !q.code) return fail(c, 'oauth_error');

  let tokens, info;
  try {
    tokens = await exchangeCode(q.code, saved.verifier);
    info = await fetchUserInfo(tokens.accessToken);
  } catch {
    return fail(c, 'oauth_error');
  }
  if (!info.emailVerified) return fail(c, 'unverified_email');

  const db = c.get('db');
  const now = c.get('now')();
  try {
    // Accounts are matched by the stable Google subject only. A new subject whose email is
    // already stored is a conflict (for example a recycled address): nothing is created or linked.
    const existing = await db.findUserIdentity(info.sub);
    let tenantId: string;
    let userId: string;
    if (existing) {
      ({ tenantId, userId } = existing);
    } else {
      if (await db.emailExists(info.email)) return fail(c, 'account_conflict');
      // A refresh token is required to act on the user's behalf; without one nothing is created.
      if (!tokens.refreshToken) return fail(c, 'oauth_error');
      tenantId = await db.createTenant();
      const user = await createUser(db.forTenant(tenantId), {
        email: info.email,
        googleSub: info.sub,
        displayName: info.name,
      });
      userId = user.id;
    }
    const handle = db.forTenant(tenantId);
    await syncGoogleConnections(handle, userId, tokens.scopes);
    if (tokens.refreshToken) {
      await vault.put(
        handle,
        userId,
        'google_refresh_token',
        REFRESH_TOKEN_REF,
        tokens.refreshToken,
      );
    }
    await activity.logActivity(handle, {
      userId,
      actor: 'user',
      action: existing ? 'signed_in' : 'account_created',
      detail: { scopes_granted: tokens.scopes.length },
    });
    const sessionId = await startSession(handle, userId, now);
    setSessionCookie(c, sessionId);
    setCookie(c, KNOWN_COOKIE, '1', {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isProduction(),
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
    });
    return c.redirect(`${webOrigin()}/`, 302);
  } catch (e) {
    // Two first sign-ins racing on one email: the unique index decides, the loser is a conflict.
    if ((e as { cause?: { code?: string } }).cause?.code === '23505')
      return fail(c, 'account_conflict');
    console.error('sign-in failed:', e instanceof Error ? e.name : 'unknown error');
    return fail(c, 'oauth_error');
  }
});

authRoutes.post('/signout', async (c) => {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) {
    const db = c.get('db');
    const found = await db.resolveSession(id);
    if (found) await endSession(db.forTenant(found.tenantId), id);
  }
  clearSessionCookie(c);
  return c.body(null, 204);
});
