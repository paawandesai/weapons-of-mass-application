import { createHash } from 'node:crypto';
import pg from 'pg';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createDb, loadEnv, type Db } from '@wma/db';
import { createApp } from '../src/app';

loadEnv();
process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';
process.env.SESSION_SECRET = 'test-session-secret-0123456789';
process.env.WEB_ORIGIN = 'http://localhost:5173';
export const WEB = 'http://localhost:5173';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wma:wma@localhost:5432/wma_test';
const appUrl = (() => {
  const u = new URL(ownerUrl);
  u.username = 'wma_app';
  u.password = process.env.APP_DB_PASSWORD || 'wma_app';
  return u.toString();
})();

export const SCOPE = {
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  calendar: 'https://www.googleapis.com/auth/calendar',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
};
export const ALL_SCOPES = ['openid', 'email', 'profile', ...Object.values(SCOPE)];

export interface Scenario {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  scopes: string[];
  refreshToken: string | null;
}

export const google = {
  scenario: null as unknown as Scenario,
  tokenRequests: [] as URLSearchParams[],
};

export const mockServer = setupServer(
  http.post('https://oauth2.googleapis.com/token', async ({ request }) => {
    google.tokenRequests.push(new URLSearchParams(await request.text()));
    const s = google.scenario;
    return HttpResponse.json({
      access_token: 'access-token-xyz',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: s.scopes.join(' '),
      ...(s.refreshToken ? { refresh_token: s.refreshToken } : {}),
    });
  }),
  http.get('https://openidconnect.googleapis.com/v1/userinfo', () => {
    const s = google.scenario;
    return HttpResponse.json({
      sub: s.sub,
      email: s.email,
      email_verified: s.emailVerified,
      name: s.name,
    });
  }),
);

let counter = 0;
export function newScenario(over: Partial<Scenario> = {}): Scenario {
  const n = `${Date.now()}-${counter++}`;
  return {
    sub: `authsub-${n}`,
    email: `auth-${n}@example.test`,
    emailVerified: true,
    name: 'Test Person',
    scopes: ALL_SCOPES,
    refreshToken: `refresh-${n}`,
    ...over,
  };
}

export interface TestEnv {
  db: Db;
  owner: pg.Pool;
  app: ReturnType<typeof createApp>;
  clock: { now: Date };
  cleanup(): Promise<void>;
}

export async function setupEnv(): Promise<TestEnv> {
  const owner = new pg.Pool({ connectionString: ownerUrl });
  const db = createDb(appUrl);
  const clock = { now: new Date() };
  const app = createApp({ db, now: () => clock.now });
  return {
    db,
    owner,
    app,
    clock,
    async cleanup() {
      await owner.query(
        'delete from tenants where id in (select tenant_id from users where email like $1)',
        ['auth-%@example.test'],
      );
      await db.close();
      await owner.end();
    },
  };
}

export function cookiesFrom(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair!.indexOf('=');
    jar[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return jar;
}

export const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

export interface SignInResult {
  res: Response;
  location: string;
  session?: string;
  jar: Record<string, string>;
  startLocation: string;
}

/** Drives start then callback for the given scenario. */
export async function signIn(
  env: TestEnv,
  scenario: Scenario,
  opts: { cookies?: Record<string, string>; tamperState?: boolean; query?: string } = {},
): Promise<SignInResult> {
  google.scenario = scenario;
  const start = await env.app.request('/auth/google/start', {
    headers: opts.cookies ? { cookie: cookieHeader(opts.cookies) } : {},
  });
  const startLocation = start.headers.get('location')!;
  const state = new URL(startLocation).searchParams.get('state')!;
  const oauthJar = cookiesFrom(start);
  const qs =
    opts.query ?? `code=auth-code&state=${opts.tamperState ? 'wrong' : encodeURIComponent(state)}`;
  const res = await env.app.request(`/auth/google/callback?${qs}`, {
    headers: { cookie: cookieHeader({ ...opts.cookies, ...oauthJar }) },
  });
  const jar = cookiesFrom(res);
  return {
    res,
    location: res.headers.get('location') ?? '',
    session: jar.wma_session,
    jar,
    startLocation,
  };
}

export const challengeOf = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
