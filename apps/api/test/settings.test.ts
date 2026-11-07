import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getUserById, insertProfileVersion, setApprovedProfileVersion } from '@wma/db';
import fixture from '../../../packages/shared/test/fixtures/profile.full.json';
import { settingsRoutes } from '../src/routes/settings';
import { appFor, json, setupEnv, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const app = (t: TestTenant) => appFor(t, { '/settings': settingsRoutes });

describe('notification settings', () => {
  it('GET returns the defaults for a new user', async () => {
    const t = await env.makeTenant();
    const res = await app(t).request('/settings/notifications');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ digest_hour: 8, timezone: 'America/Los_Angeles' });
  });

  it('PUT stores the hour and zone and GET returns them', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    const res = await a.request(
      '/settings/notifications',
      json({ digest_hour: 18, timezone: 'Europe/Lisbon' }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ digest_hour: 18, timezone: 'Europe/Lisbon' });
    expect(await (await a.request('/settings/notifications')).json()).toEqual({
      digest_hour: 18,
      timezone: 'Europe/Lisbon',
    });
    const user = await getUserById(t.handle, t.userId);
    expect(user).toMatchObject({ digestHour: 18, timezone: 'Europe/Lisbon' });
  });

  it('PUT with one field leaves the other unchanged', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    await a.request('/settings/notifications', json({ digest_hour: 6 }, 'PUT'));
    const res = await a.request('/settings/notifications', json({ timezone: 'Asia/Tokyo' }, 'PUT'));
    expect(await res.json()).toEqual({ digest_hour: 6, timezone: 'Asia/Tokyo' });
  });

  it('rejects an invalid time zone with 400 and changes nothing', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    for (const timezone of ['Mars/Olympus', '', 'PST8PDT-ish', '+01:00', 42]) {
      const res = await a.request('/settings/notifications', json({ timezone }, 'PUT'));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('validation');
    }
    expect(await getUserById(t.handle, t.userId)).toMatchObject({
      digestHour: 8,
      timezone: 'America/Los_Angeles',
    });
  });

  it('rejects an hour outside 0..23, a non-integer hour, an empty body and bad JSON', async () => {
    const t = await env.makeTenant();
    const a = app(t);
    for (const body of [{ digest_hour: 24 }, { digest_hour: -1 }, { digest_hour: 7.5 }, {}]) {
      const res = await a.request('/settings/notifications', json(body, 'PUT'));
      expect(res.status).toBe(400);
    }
    const bad = await a.request('/settings/notifications', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect((await getUserById(t.handle, t.userId)).digestHour).toBe(8);
  });

  it('an update is what the digest scheduler reads next (digestRoster)', async () => {
    const t = await env.makeTenant();
    const v = await insertProfileVersion(t.handle, {
      userId: t.userId,
      document: fixture as never,
    });
    await setApprovedProfileVersion(t.handle, t.userId, v.version);
    const entry = async () => (await env.db.digestRoster()).find((r) => r.userId === t.userId);
    expect(await entry()).toMatchObject({ digestHour: 8, timezone: 'America/Los_Angeles' });

    const res = await app(t).request(
      '/settings/notifications',
      json({ digest_hour: 21, timezone: 'Australia/Sydney' }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect(await entry()).toMatchObject({
      tenantId: t.id,
      digestHour: 21,
      timezone: 'Australia/Sydney',
    });
  });
});
