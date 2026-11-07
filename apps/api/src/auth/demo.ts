import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { activity } from '@wma/db';
import { isProduction, setSessionCookie, type AppEnv } from '../middleware/session';
import { startSession } from './sessions';

export const DEMO_TOKEN_HEADER = 'x-demo-token';

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bodyToken(req: Request): Promise<string> {
  try {
    const b = (await req.json()) as { token?: unknown };
    return typeof b.token === 'string' ? b.token : '';
  } catch {
    return '';
  }
}

export const demoAuthRoutes = new Hono<AppEnv>();

/**
 * Demo sign-in (design rule 13). Creates a session for the demo tenant's user only when the
 * server is not in production, `DEMO_LOGIN_TOKEN` is set and the request carries it (header
 * `X-Demo-Token` or JSON `{token}`). Every other case, including no demo user, answers 404 so the
 * route is indistinguishable from an absent one.
 */
demoAuthRoutes.post('/', async (c) => {
  const expected = process.env.DEMO_LOGIN_TOKEN;
  const notFound = () => c.json({ code: 'not_found', message: 'Not found' }, 404);
  if (isProduction() || !expected) return notFound();
  const given = c.req.header(DEMO_TOKEN_HEADER) || (await bodyToken(c.req.raw));
  if (!given || !sameToken(given, expected)) return notFound();
  const db = c.get('db');
  const demo = await db.demoUser();
  if (!demo) return notFound();
  const handle = db.forTenant(demo.tenantId);
  await activity.logActivity(handle, {
    userId: demo.userId,
    actor: 'user',
    action: 'signed_in',
    detail: { demo: true },
  });
  const sessionId = await startSession(handle, demo.userId, c.get('now')());
  setSessionCookie(c, sessionId);
  return c.json({ ok: true });
});
