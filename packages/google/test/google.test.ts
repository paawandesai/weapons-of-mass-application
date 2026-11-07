import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activity } from '@wma/db';
import { GoogleNotConnectedError, GoogleRevokedError, withGoogle } from '../src';
import { setupFixture, type Fixture } from './helpers';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const server = setupServer();
let refreshBodies: string[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let fx: Fixture;
beforeEach(async () => {
  refreshBodies = [];
  fx = await setupFixture();
});
afterEach(async () => {
  await fx.cleanup();
});

const statuses = async () => {
  const r = await fx.owner.query(
    'select kind, status, disconnected_at from source_connections where user_id = $1 order by kind::text',
    [fx.userId],
  );
  return r.rows as Array<{ kind: string; status: string; disconnected_at: Date | null }>;
};

describe('withGoogle', () => {
  it('uses the vaulted refresh token to mint an access token', async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        refreshBodies.push(await request.text());
        return HttpResponse.json({ access_token: 'at-1', expires_in: 3600, token_type: 'Bearer' });
      }),
    );
    const token = await withGoogle(fx.handle, fx.userId, async (auth) => {
      const t = await auth.getAccessToken();
      return t.token;
    });
    expect(token).toBe('at-1');
    expect(new URLSearchParams(refreshBodies[0]).get('refresh_token')).toBe('refresh-token-1');
    expect((await statuses()).every((s) => s.status === 'connected')).toBe(true);
  });

  it('flips gmail, calendar and drive to disconnected and logs on invalid_grant', async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          { status: 400 },
        ),
      ),
    );
    await expect(
      withGoogle(fx.handle, fx.userId, (auth) => auth.getAccessToken()),
    ).rejects.toBeInstanceOf(GoogleRevokedError);

    const rows = await statuses();
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['calendar', 'disconnected'],
      ['drive', 'disconnected'],
      ['gmail', 'disconnected'],
    ]);
    expect(rows.every((r) => r.disconnected_at !== null)).toBe(true);

    const log = await activity.listByUser(fx.handle, fx.userId);
    const entry = log.filter((l) => l.action === 'google_token_revoked');
    expect(entry).toHaveLength(1);
    expect(entry[0]!.detail).toEqual({ disconnected: ['calendar', 'drive', 'gmail'] });
  });

  it('leaves connections alone for other failures', async () => {
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: 'server_error' }, { status: 500 })),
    );
    await expect(
      withGoogle(fx.handle, fx.userId, (auth) => auth.getAccessToken()),
    ).rejects.not.toBeInstanceOf(GoogleRevokedError);
    expect((await statuses()).every((s) => s.status === 'connected')).toBe(true);
    expect(
      (await activity.listByUser(fx.handle, fx.userId)).some(
        (l) => l.action === 'google_token_revoked',
      ),
    ).toBe(false);
  });

  it('reports a missing refresh token as not connected', async () => {
    await fx.owner.query('delete from secrets where tenant_id = $1', [fx.tenantId]);
    await expect(withGoogle(fx.handle, fx.userId, async () => 1)).rejects.toBeInstanceOf(
      GoogleNotConnectedError,
    );
  });
});
