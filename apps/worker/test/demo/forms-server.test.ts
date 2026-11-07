import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFormsServer,
  startFormsServerFromEnv,
  type FormsServer,
} from '../../src/demo/forms-server';

let server: FormsServer;
beforeAll(async () => {
  server = await startFormsServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
});

describe('fixture forms server', () => {
  it('serves a fixture file', async () => {
    const res = await fetch(`${server.origin}/forms/greenhouse/form.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<form');
  });

  it('serves the vendor form for a posting id and the shared script', async () => {
    const byId = await fetch(`${server.origin}/forms/lever/abc-123`);
    expect(byId.status).toBe(200);
    expect(await byId.text()).toContain('<form');
    const js = await fetch(`${server.origin}/forms/_shared/fixture.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('refuses paths outside the fixtures and unknown paths', async () => {
    const escape = await fetch(`${server.origin}/forms/..%2F..%2Fpackage.json`);
    expect(escape.status).toBe(404);
    expect((await fetch(`${server.origin}/other`)).status).toBe(404);
  });

  it('starts only when DEMO_FORMS_PORT is set', async () => {
    expect(await startFormsServerFromEnv({})).toBeNull();
    const s = await startFormsServerFromEnv({ DEMO_FORMS_PORT: '0' });
    expect(s).not.toBeNull();
    await s!.close();
    await expect(startFormsServerFromEnv({ DEMO_FORMS_PORT: 'x' })).rejects.toThrow();
  });
});
