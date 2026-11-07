import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vault } from '@wma/db';
import { createApp } from '../src/app';
import {
  ALL_SCOPES,
  SCOPE,
  WEB,
  challengeOf,
  google,
  mockServer,
  newScenario,
  setupEnv,
  signIn,
  type TestEnv,
} from './helpers';

let env: TestEnv;
beforeAll(async () => {
  mockServer.listen({
    // Loopback requests (the real-socket test) go through; anything else unmocked fails loudly.
    onUnhandledRequest(req, print) {
      if (new URL(req.url).hostname === '127.0.0.1') return;
      print.error();
    },
  });
  env = await setupEnv();
});
afterAll(async () => {
  mockServer.close();
  await env.cleanup();
});
beforeEach(() => {
  google.tokenRequests = [];
  env.clock.now = new Date();
});
afterEach(() => mockServer.resetHandlers());

const count = async (sql: string, args: unknown[]) =>
  Number((await env.owner.query(sql, args)).rows[0].n);

const userBy = async (email: string) =>
  (await env.owner.query('select id, tenant_id from users where email = $1', [email])).rows[0] as
    { id: string; tenant_id: string } | undefined;

const connections = async (userId: string) =>
  (
    await env.owner.query(
      'select kind, status, config from source_connections where user_id = $1 order by kind::text',
      [userId],
    )
  ).rows as Array<{ kind: string; status: string; config: Record<string, unknown> }>;

describe('GET /auth/google/start', () => {
  it('redirects to Google with PKCE, offline access, consent and the five scopes', async () => {
    google.scenario = newScenario();
    const res = await env.app.request('/auth/google/start');
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBeTruthy();
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')!.split(' ').sort()).toEqual([...ALL_SCOPES].sort());
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/wma_oauth=/);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('sends the verifier that matches the challenge to the token endpoint', async () => {
    const r = await signIn(env, newScenario());
    expect(r.location).toBe(`${WEB}/`);
    const challenge = new URL(r.startLocation).searchParams.get('code_challenge');
    const body = google.tokenRequests[0]!;
    expect(challengeOf(body.get('code_verifier')!)).toBe(challenge);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
  });
});

describe('GET /auth/google/callback', () => {
  it('first sign-in creates tenant, user, three connections, a vault secret and a session', async () => {
    const s = newScenario();
    const r = await signIn(env, s);
    expect(r.res.status).toBe(302);
    expect(r.location).toBe(`${WEB}/`);
    expect(r.session).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const user = await userBy(s.email);
    expect(user).toBeDefined();
    expect(await count('select count(*) n from tenants where id = $1', [user!.tenant_id])).toBe(1);
    expect((await connections(user!.id)).map((c) => [c.kind, c.status])).toEqual([
      ['calendar', 'connected'],
      ['drive', 'connected'],
      ['gmail', 'connected'],
    ]);

    // Secret is stored encrypted and readable only through the vault.
    const handle = env.db.forTenant(user!.tenant_id);
    const got = await vault.get(handle, user!.id, 'google_refresh_token', 'google');
    expect(got).toEqual({ ok: true, value: s.refreshToken });
    const raw = await env.owner.query('select ciphertext from secrets where tenant_id = $1', [
      user!.tenant_id,
    ]);
    expect(raw.rows).toHaveLength(1);
    expect(Buffer.from(raw.rows[0].ciphertext).toString('utf8')).not.toContain(s.refreshToken!);

    expect(
      await count('select count(*) n from sessions where id = $1 and user_id = $2', [
        r.session,
        user!.id,
      ]),
    ).toBe(1);
  });

  it('sets an HttpOnly SameSite=Lax session cookie with a 30 day lifetime', async () => {
    const r = await signIn(env, newScenario());
    const line = r.res.headers.getSetCookie().find((c) => c.startsWith('wma_session='))!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Max-Age=2592000/);
    expect(line).not.toMatch(/Secure/i);
  });

  it('marks the session cookie Secure in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await signIn(env, newScenario());
      const line = r.res.headers.getSetCookie().find((c) => c.startsWith('wma_session='))!;
      expect(line).toMatch(/Secure/i);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('returning sign-in reuses the user and tenant and issues a new session', async () => {
    const s = newScenario();
    const first = await signIn(env, s);
    const user = await userBy(s.email);

    const again = await signIn(env, { ...s, refreshToken: null }, { cookies: { wma_known: '1' } });
    expect(again.location).toBe(`${WEB}/`);
    expect(again.session).toBeTruthy();
    expect(again.session).not.toBe(first.session);
    expect(new URL(again.startLocation).searchParams.get('prompt')).toBeNull();

    expect(await count('select count(*) n from users where google_sub = $1', [s.sub])).toBe(1);
    expect(await count('select count(*) n from tenants where id = $1', [user!.tenant_id])).toBe(1);
    expect(await count('select count(*) n from sessions where user_id = $1', [user!.id])).toBe(2);
    // No new refresh token was issued, so the stored one is kept.
    const got = await vault.get(
      env.db.forTenant(user!.tenant_id),
      user!.id,
      'google_refresh_token',
      'google',
    );
    expect(got).toEqual({ ok: true, value: s.refreshToken });
  });

  it('returning sign-in replaces the refresh token when Google issues a new one and updates scopes', async () => {
    const s = newScenario();
    await signIn(env, s);
    const user = (await userBy(s.email))!;
    await signIn(env, {
      ...s,
      refreshToken: 'brand-new-refresh',
      scopes: ALL_SCOPES.filter((x) => x !== SCOPE.calendar),
    });
    const got = await vault.get(
      env.db.forTenant(user.tenant_id),
      user.id,
      'google_refresh_token',
      'google',
    );
    expect(got).toEqual({ ok: true, value: 'brand-new-refresh' });
    const conns = await connections(user.id);
    expect(conns).toHaveLength(3);
    expect(conns.find((c) => c.kind === 'calendar')!.status).toBe('disconnected');
    expect(conns.find((c) => c.kind === 'gmail')!.status).toBe('connected');
  });

  it('refuses an unverified email and creates nothing', async () => {
    const s = newScenario({ emailVerified: false });
    const r = await signIn(env, s);
    expect(r.location).toBe(`${WEB}/signin?error=unverified_email`);
    expect(r.session).toBeUndefined();
    expect(await userBy(s.email)).toBeUndefined();
  });

  it('declined Drive scope leaves Drive disconnected and the rest connected', async () => {
    const s = newScenario({ scopes: ALL_SCOPES.filter((x) => x !== SCOPE.drive) });
    const r = await signIn(env, s);
    expect(r.location).toBe(`${WEB}/`);
    const user = (await userBy(s.email))!;
    const conns = await connections(user.id);
    expect(conns.map((c) => [c.kind, c.status])).toEqual([
      ['calendar', 'connected'],
      ['drive', 'disconnected'],
      ['gmail', 'connected'],
    ]);
    expect(conns.find((c) => c.kind === 'drive')!.config).toEqual({
      missing_scopes: [SCOPE.drive],
    });
  });

  it('treats Gmail as connected only when both read and send were granted', async () => {
    const s = newScenario({ scopes: ALL_SCOPES.filter((x) => x !== SCOPE.gmailSend) });
    await signIn(env, s);
    const conns = await connections((await userBy(s.email))!.id);
    expect(conns.find((c) => c.kind === 'gmail')!.status).toBe('disconnected');
  });

  it('maps a denied consent screen to the declined code', async () => {
    const r = await signIn(env, newScenario(), { query: 'error=access_denied' });
    expect(r.location).toBe(`${WEB}/signin?error=declined`);
  });

  it('rejects a state that does not match the cookie', async () => {
    const s = newScenario();
    const r = await signIn(env, s, { tamperState: true });
    expect(r.location).toBe(`${WEB}/signin?error=oauth_error`);
    expect(await userBy(s.email)).toBeUndefined();
  });

  it('rejects a callback with no state cookie', async () => {
    const res = await env.app.request('/auth/google/callback?code=x&state=y');
    expect(res.headers.get('location')).toBe(`${WEB}/signin?error=oauth_error`);
  });

  it('refuses a first sign-in that came back without a refresh token', async () => {
    const s = newScenario({ refreshToken: null });
    const r = await signIn(env, s);
    expect(r.location).toBe(`${WEB}/signin?error=oauth_error`);
    expect(await userBy(s.email)).toBeUndefined();
  });
});

describe('account matching and redirects', () => {
  it('an unknown Google subject with an already-stored email is a conflict and creates nothing', async () => {
    const s = newScenario();
    await signIn(env, s);
    const owner = (await userBy(s.email))!;
    const usersBefore = await count("select count(*) n from users where email like 'auth-%'", []);
    const sessionsBefore = await count('select count(*) n from sessions where user_id = $1', [
      owner.id,
    ]);

    const intruder = { ...s, sub: `${s.sub}-recycled`, refreshToken: 'intruder-refresh' };
    const r = await signIn(env, intruder);
    expect(r.location).toBe(`${WEB}/signin?error=account_conflict`);
    expect(r.session).toBeUndefined();

    expect(await count('select count(*) n from users where email = $1', [s.email])).toBe(1);
    expect(await count("select count(*) n from users where email like 'auth-%'", [])).toBe(
      usersBefore,
    );
    expect(await count('select count(*) n from sessions where user_id = $1', [owner.id])).toBe(
      sessionsBefore,
    );
    const stored = await vault.get(
      env.db.forTenant(owner.tenant_id),
      owner.id,
      'google_refresh_token',
      'google',
    );
    expect(stored).toEqual({ ok: true, value: s.refreshToken });
  });

  it('a returning sign-in matches by Google subject even if the email changed', async () => {
    const s = newScenario();
    await signIn(env, s);
    const owner = (await userBy(s.email))!;
    const r = await signIn(env, { ...s, email: `auth-moved-${s.sub}@example.test` });
    expect(r.location).toBe(`${WEB}/`);
    expect(await count('select count(*) n from users where google_sub = $1', [s.sub])).toBe(1);
    expect(
      await count('select count(*) n from sessions where id = $1 and user_id = $2', [
        r.session,
        owner.id,
      ]),
    ).toBe(1);
  });

  it('keeps the selected Drive folders across a returning sign-in', async () => {
    const s = newScenario();
    await signIn(env, s);
    const user = (await userBy(s.email))!;
    await env.owner.query(
      `update source_connections set config = $2::jsonb where user_id = $1 and kind = 'drive'`,
      [user.id, JSON.stringify({ folder_ids: ['f1', 'f2'], folders: [{ id: 'f1', name: 'A' }] })],
    );
    await signIn(env, { ...s, refreshToken: null }, { cookies: { wma_known: '1' } });
    const drive = (await connections(user.id)).find((c) => c.kind === 'drive')!;
    expect(drive.status).toBe('connected');
    expect(drive.config).toEqual({ folder_ids: ['f1', 'f2'], folders: [{ id: 'f1', name: 'A' }] });
    expect(
      await count('select count(*) n from source_connections where user_id = $1', [user.id]),
    ).toBe(3);

    // Losing the Drive scope keeps the selection too, only flagging what is missing.
    await signIn(env, {
      ...s,
      refreshToken: null,
      scopes: ALL_SCOPES.filter((x) => x !== SCOPE.drive),
    });
    const lost = (await connections(user.id)).find((c) => c.kind === 'drive')!;
    expect(lost.status).toBe('disconnected');
    expect(lost.config).toMatchObject({ folder_ids: ['f1', 'f2'], missing_scopes: [SCOPE.drive] });
    await signIn(env, { ...s, refreshToken: null });
    const back = (await connections(user.id)).find((c) => c.kind === 'drive')!;
    expect(back.config).toEqual({ folder_ids: ['f1', 'f2'], folders: [{ id: 'f1', name: 'A' }] });
  });

  it('redirects to WEB_ORIGIN after success and failure', async () => {
    const prev = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = 'https://app.example.test/';
    try {
      const ok = await signIn(env, newScenario());
      expect(ok.location).toBe('https://app.example.test/');
      const bad = await signIn(env, newScenario({ emailVerified: false }));
      expect(bad.location).toBe('https://app.example.test/signin?error=unverified_email');
    } finally {
      process.env.WEB_ORIGIN = prev;
    }
  });
});

describe('sessions', () => {
  const sessionRow = async (id: string) =>
    (await env.owner.query('select expires_at from sessions where id = $1', [id])).rows[0] as
      { expires_at: Date } | undefined;
  const me = (cookie?: string) =>
    env.app.request('/api/me', { headers: cookie ? { cookie: `wma_session=${cookie}` } : {} });
  const DAY = 24 * 3600 * 1000;

  it('GET /api/me returns the contract shape', async () => {
    const s = newScenario({ scopes: ALL_SCOPES.filter((x) => x !== SCOPE.drive) });
    const r = await signIn(env, s);
    const res = await me(r.session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Array<{ kind: string }> };
    body.connections.sort((a, b) => a.kind.localeCompare(b.kind));
    const user = (await userBy(s.email))!;
    expect(body).toEqual({
      user: {
        id: user.id,
        email: s.email,
        display_name: 'Test Person',
        approved_profile_version: null,
        approved_profile_at: null,
        daily_target: 12,
        digest_hour: 8,
      },
      connections: [
        { kind: 'calendar', status: 'connected', config: {}, connected_at: expect.any(String) },
        {
          kind: 'drive',
          status: 'disconnected',
          config: { missing_scopes: [SCOPE.drive] },
          connected_at: expect.any(String),
        },
        { kind: 'gmail', status: 'connected', config: {}, connected_at: expect.any(String) },
      ],
    });
  });

  it('sign-out deletes the row, clears the cookie and invalidates the session', async () => {
    const r = await signIn(env, newScenario());
    expect((await me(r.session)).status).toBe(200);
    const out = await env.app.request('/auth/signout', {
      method: 'POST',
      headers: { cookie: `wma_session=${r.session}` },
    });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().join('\n')).toMatch(/wma_session=;/);
    expect(await sessionRow(r.session!)).toBeUndefined();
    const after = await me(r.session);
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects an expired session', async () => {
    const r = await signIn(env, newScenario());
    await env.owner.query(
      "update sessions set expires_at = now() - interval '1 minute' where id = $1",
      [r.session],
    );
    const res = await me(r.session);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' }); // ('unauthenticated');
  });

  it('rejects a session unused for more than 30 days (clock moves on)', async () => {
    const r = await signIn(env, newScenario());
    env.clock.now = new Date(Date.now() + 31 * DAY);
    expect((await me(r.session)).status).toBe(401);
  });

  it('slides the expiry forward when used', async () => {
    const r = await signIn(env, newScenario());
    await env.owner.query(
      "update sessions set expires_at = now() + interval '10 days' where id = $1",
      [r.session],
    );
    const res = await me(r.session);
    expect(res.status).toBe(200);
    const row = await sessionRow(r.session!);
    const days = (row!.expires_at.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(res.headers.getSetCookie().join('\n')).toMatch(/wma_session=/);
  });

  it('writes the expiry at most once per hour', async () => {
    const r = await signIn(env, newScenario());
    const before = await sessionRow(r.session!);
    await me(r.session);
    const after = await sessionRow(r.session!);
    expect(after!.expires_at.getTime()).toBe(before!.expires_at.getTime());
  });

  it('rejects an unknown session id', async () => {
    expect((await me('not-a-real-session')).status).toBe(401);
  });
});

describe('http', () => {
  it('GET /api/me without a cookie is 401 {code:unauthenticated} over a real socket', async () => {
    const server = serve({ fetch: createApp({ db: env.db }).fetch, port: 0 });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/me`);
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toMatch(/json/);
      expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
