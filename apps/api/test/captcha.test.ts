import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applicationFileKey,
  getCaptchaRequest,
  insertApplication,
  insertCaptchaRequest,
  putFile,
  updateCaptchaRequest,
  upsertJob,
} from '@wma/db';
import type { AppEnv } from '../src/middleware/session';
import { captchaRoutes } from '../src/routes/captcha';
import { setupEnv, type TestEnv, type TestTenant } from './support';

process.env.FILE_STORE_DIR = mkdtempSync(join(tmpdir(), 'wma-api-captcha-'));

let env: TestEnv;
let now = new Date();
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const app = (db = env.db) => {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    c.set('now', () => now);
    await next();
  });
  a.route('/captcha', captchaRoutes);
  return a;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const form = (answer: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ answer }).toString(),
});

/** An application with a human-stage request open for another 15 minutes. */
async function openRequest(t: TestTenant, over: { expiresInMs?: number } = {}) {
  now = new Date();
  const { job } = await upsertJob(t.handle, {
    title: 'Engineer',
    url: `https://jobs.example.test/${randomBytes(6).toString('hex')}`,
  });
  const { application } = await insertApplication(t.handle, { userId: t.userId, jobId: job.id });
  const imageRef = applicationFileKey(t.id, application.id, 'captcha-1.png');
  await putFile(t.handle, imageRef, Buffer.from('not-really-a-png'));
  const req = await insertCaptchaRequest(t.handle, {
    userId: t.userId,
    applicationId: application.id,
    imageRef,
    stage: 'human',
  });
  const token = randomBytes(32).toString('base64url');
  await updateCaptchaRequest(t.handle, req.id, {
    tokenHash: sha256(token),
    expiresAt: new Date(now.getTime() + (over.expiresInMs ?? 900_000)),
  });
  return { req, token };
}

describe('GET /captcha/:token', () => {
  it('renders a form with the challenge image for an open request', async () => {
    const t = await env.makeTenant();
    const { token } = await openRequest(t);
    const res = await app().request(`/captcha/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<form method="post">');
    expect(html).toContain('name="answer"');
    expect(html).toContain(
      `src="data:image/png;base64,${Buffer.from('not-really-a-png').toString('base64')}"`,
    );
    expect(html).not.toContain(token);
  });

  it('says the request is no longer open for unknown, malformed and expired links', async () => {
    const t = await env.makeTenant();
    // Expiry is judged by the database clock, so the window is simply already over.
    const { token } = await openRequest(t, { expiresInMs: -1000 });
    for (const path of [
      `/captcha/${token}`,
      `/captcha/${randomBytes(32).toString('base64url')}`,
      '/captcha/x',
    ]) {
      const res = await app().request(path);
      expect(res.status).toBe(410);
      expect(await res.text()).toContain('no longer open');
    }
  });
});

describe('token replacement', () => {
  it('a consumed token shows 410 even if the lookup raced the worker issuing a new one', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t);
    const fresh = randomBytes(32).toString('base64url');
    // The tenant lookup succeeds, then the worker swaps the token before the request is loaded.
    const racing = Object.assign(Object.create(env.db), {
      async resolveCaptchaToken(hash: string) {
        const found = await env.db.resolveCaptchaToken(hash);
        await updateCaptchaRequest(t.handle, req.id, { tokenHash: sha256(fresh) });
        return found;
      },
    });
    const res = await app(racing).request(`/captcha/${token}`);
    expect(res.status).toBe(410);
    expect(await res.text()).not.toContain('<form');
    expect((await app().request(`/captcha/${fresh}`)).status).toBe(200);
  });
});

describe('POST /captcha/:token', () => {
  it('writes the human answer once for a valid, unexpired, unanswered token', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t);
    const res = await app().request(`/captcha/${token}`, form('  ab12X '));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Thank you');
    expect((await getCaptchaRequest(t.handle, req.id))?.humanAnswer).toBe('ab12X');
  });

  it('accepts a JSON body too', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t);
    const res = await app().request(`/captcha/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'zz9' }),
    });
    expect(res.status).toBe(200);
    expect((await getCaptchaRequest(t.handle, req.id))?.humanAnswer).toBe('zz9');
  });

  it('a reused token is 410 "no longer open" and writes nothing', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t);
    expect((await app().request(`/captcha/${token}`, form('first'))).status).toBe(200);
    const again = await app().request(`/captcha/${token}`, form('second'));
    expect(again.status).toBe(410);
    expect(await again.text()).toContain('no longer open');
    expect((await getCaptchaRequest(t.handle, req.id))?.humanAnswer).toBe('first');
  });

  it('an expired token is 410 and writes nothing', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t, { expiresInMs: -1000 });
    const res = await app().request(`/captcha/${token}`, form('late'));
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('no longer open');
    expect((await getCaptchaRequest(t.handle, req.id))?.humanAnswer).toBeNull();
  });

  it('judges expiry when the answer is written, not when the request began', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t, { expiresInMs: 400 });
    // The POST starts inside the window but its body only finishes after it.
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((r) => setTimeout(r, 900));
        controller.enqueue(new TextEncoder().encode('answer=late'));
        controller.close();
      },
    });
    const res = await app().request(
      new Request(`http://localhost/captcha/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: slow,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(410);
    expect((await getCaptchaRequest(t.handle, req.id))?.humanAnswer).toBeNull();
  });

  it('a resolved or expired request takes no answer even inside the window', async () => {
    const t = await env.makeTenant();
    const resolved = await openRequest(t);
    await updateCaptchaRequest(t.handle, resolved.req.id, {
      resolvedAt: new Date(),
      resolvedBy: 'human',
    });
    expect((await app().request(`/captcha/${resolved.token}`, form('x'))).status).toBe(410);
    const expired = await openRequest(t);
    await updateCaptchaRequest(t.handle, expired.req.id, { expiredAt: new Date() });
    expect((await app().request(`/captcha/${expired.token}`, form('x'))).status).toBe(410);
    expect((await getCaptchaRequest(t.handle, resolved.req.id))?.humanAnswer).toBeNull();
    expect((await getCaptchaRequest(t.handle, expired.req.id))?.humanAnswer).toBeNull();
  });

  it('an empty answer is asked for again without using up the link', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t);
    const res = await app().request(`/captcha/${token}`, form('   '));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Enter the characters');
    expect((await getCaptchaRequest(t.handle, req.id))?.humanAnswer).toBeNull();
    expect((await app().request(`/captcha/${token}`, form('ok'))).status).toBe(200);
  });

  it('only one of two simultaneous replies is written', async () => {
    const t = await env.makeTenant();
    const { req, token } = await openRequest(t);
    const results = await Promise.all([
      app().request(`/captcha/${token}`, form('one')),
      app().request(`/captcha/${token}`, form('two')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    const answer = (await getCaptchaRequest(t.handle, req.id))?.humanAnswer;
    expect(['one', 'two']).toContain(answer);
  });
});
