import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, getConnection, listActiveConnections, upsertConnection } from '@wma/db';
import { meRoutes } from '../src/routes/me';
import { createProfileRoutes } from '../src/routes/profile';
import { createSourcesRoutes } from '../src/routes/sources';
import { DriveNotConnectedError, type DriveFolderPort } from '../src/services/drive';
import { appFor, json, setupEnv, type TestApp, type TestEnv, type TestTenant } from './support';

let env: TestEnv;
let storeDir: string;
beforeAll(async () => {
  env = await setupEnv();
  storeDir = await mkdtemp(join(tmpdir(), 'wma-files-'));
});
afterAll(async () => {
  await env.cleanup();
  await rm(storeDir, { recursive: true, force: true });
});

const fx = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

function upload(app: TestApp, bytes: Uint8Array | string, name: string, type: string) {
  const form = new FormData();
  form.set('file', new File([bytes], name, { type }));
  return app.request('/sources/resume', { method: 'POST', body: form });
}

const okFetch = (body: string, status = 200): typeof fetch =>
  (async () =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } })) as typeof fetch;

const sourcesApp = (t: TestTenant, over: Parameters<typeof createSourcesRoutes>[0] = {}) =>
  appFor(t, { '/sources': createSourcesRoutes({ fileStoreDir: () => storeDir, ...over }) });

describe('resume upload', () => {
  it('accepts a PDF, stores it under <tenant>/<user>/resume.pdf and caches non-empty text', async () => {
    const t = await env.makeTenant();
    const res = await upload(sourcesApp(t), await fx('resume.pdf'), 'cv.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection).toMatchObject({ kind: 'resume', status: 'connected' });
    expect(connection.connected_at).toBeTruthy();
    expect(connection.config.text).toContain('Mara Quill');
    expect(connection.config.text).toContain('Acme Corp');
    expect(existsSync(join(storeDir, t.id, t.userId, 'resume.pdf'))).toBe(true);
    const row = await getConnection(t.handle, t.userId, 'resume');
    expect(row?.fileRef).toBe(join(t.id, t.userId, 'resume.pdf'));
  });

  it('accepts a DOCX and extracts its text', async () => {
    const t = await env.makeTenant();
    const res = await upload(
      sourcesApp(t),
      await fx('resume.docx'),
      'cv.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection.config.text.length).toBeGreaterThan(50);
    expect(connection.config.text).toContain('University of Porto');
    expect(existsSync(join(storeDir, t.id, t.userId, 'resume.docx'))).toBe(true);
  });

  it('rejects a PNG with unsupported_type and creates no connection', async () => {
    const t = await env.makeTenant();
    const res = await upload(sourcesApp(t), await fx('not-a-resume.png'), 'cv.png', 'image/png');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_type');
    expect(await getConnection(t.handle, t.userId, 'resume')).toBeNull();
  });

  it('rejects a PNG renamed to .pdf (type is read from the bytes)', async () => {
    const t = await env.makeTenant();
    const res = await upload(
      sourcesApp(t),
      await fx('not-a-resume.png'),
      'cv.pdf',
      'application/pdf',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_type');
  });

  it('rejects a file over 10 MB with too_large and stores nothing', async () => {
    const t = await env.makeTenant();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(Buffer.from('%PDF-1.7\n'));
    const res = await upload(sourcesApp(t), big, 'big.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('too_large');
    expect(await getConnection(t.handle, t.userId, 'resume')).toBeNull();
    expect(existsSync(join(storeDir, t.id))).toBe(false);
  });

  it('rejects a corrupt PDF as unreadable_file and a request with no file as validation', async () => {
    const t = await env.makeTenant();
    const bad = await upload(
      sourcesApp(t),
      '%PDF-1.7 this is not a pdf',
      'x.pdf',
      'application/pdf',
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('unreadable_file');
    const none = await sourcesApp(t).request('/sources/resume', {
      method: 'POST',
      body: new FormData(),
    });
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe('validation');
  });

  it('cuts off a chunked body with no Content-Length at the limit instead of buffering it', async () => {
    const t = await env.makeTenant();
    const boundary = 'wmaboundary';
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`,
    );
    const TOTAL_CHUNKS = 400; // about 25 MB if it were all read
    let pulled = 0;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(head);
        else if (sent <= TOTAL_CHUNKS) {
          controller.enqueue(chunk);
          pulled++;
        } else {
          controller.enqueue(Buffer.from(`\r\n--${boundary}--\r\n`));
          controller.close();
        }
        sent++;
      },
    });
    const req = new Request('http://localhost/sources/resume', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    const res = await sourcesApp(t).request('/sources/resume', req as unknown as RequestInit);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('too_large');
    // The stream was abandoned shortly after the limit, far short of the full 25 MB.
    expect(pulled).toBeLessThan(200);
    expect(await getConnection(t.handle, t.userId, 'resume')).toBeNull();
  });

  it('rejects a declared oversize body up front', async () => {
    const t = await env.makeTenant();
    const form = new FormData();
    form.set('file', new File([new Uint8Array(11 * 1024 * 1024)], 'big.pdf'));
    const res = await sourcesApp(t).request('/sources/resume', { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('too_large');
  });

  it('concurrent uploads for one user serialize: one consistent file, no temp files left', async () => {
    const t = await env.makeTenant();
    const app = sourcesApp(t);
    const pdf = await fx('resume.pdf');
    const docx = await fx('resume.docx');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? upload(app, pdf, 'cv.pdf', 'application/pdf')
          : upload(app, docx, 'cv.docx', ''),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    const row = await getConnection(t.handle, t.userId, 'resume');
    const config = row!.config as { format: string };
    expect(row!.fileRef).toBe(join(t.id, t.userId, `resume.${config.format}`));
    expect(await readdir(join(storeDir, t.id, t.userId))).toEqual([`resume.${config.format}`]);
    const stored = await readFile(join(storeDir, row!.fileRef!));
    expect(stored.equals(config.format === 'pdf' ? pdf : docx)).toBe(true);
  });

  it('concurrent upload and disconnect leave file and connection in agreement', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await env.makeTenant();
      const app = sourcesApp(t);
      await upload(app, await fx('resume.pdf'), 'cv.pdf', 'application/pdf');
      await Promise.all([
        upload(app, await fx('resume.docx'), 'cv.docx', ''),
        app.request('/sources/resume', { method: 'DELETE' }),
      ]);
      const row = await getConnection(t.handle, t.userId, 'resume');
      const dir = join(storeDir, t.id, t.userId);
      const files = existsSync(dir) ? await readdir(dir) : [];
      if (row?.status === 'connected') {
        expect(files).toEqual([row.fileRef!.split('/').pop()]);
      } else {
        expect(files).toEqual([]);
      }
    }
  });

  it('GET /api/me lists the resume connection without its cached text', async () => {
    const t = await env.makeTenant();
    const app = appFor(t, {
      '/sources': createSourcesRoutes({ fileStoreDir: () => storeDir }),
      '/me': meRoutes,
    });
    await upload(app, await fx('resume.pdf'), 'cv.pdf', 'application/pdf');
    const me = await (await app.request('/me')).json();
    const resume = me.connections.find((c: { kind: string }) => c.kind === 'resume');
    expect(resume.config).toMatchObject({ filename: 'cv.pdf', format: 'pdf' });
    expect(resume.config).not.toHaveProperty('text');
  });

  it('replacing a PDF with a DOCX leaves only the new file', async () => {
    const t = await env.makeTenant();
    const app = sourcesApp(t);
    await upload(app, await fx('resume.pdf'), 'cv.pdf', 'application/pdf');
    await upload(app, await fx('resume.docx'), 'cv.docx', '');
    expect(existsSync(join(storeDir, t.id, t.userId, 'resume.pdf'))).toBe(false);
    expect(existsSync(join(storeDir, t.id, t.userId, 'resume.docx'))).toBe(true);
  });
});

describe('linkedin, github and drive connections', () => {
  it('stores a valid LinkedIn URL with the fetched page text', async () => {
    const t = await env.makeTenant();
    const html =
      '<html><head><title>Mara Quill - Senior Backend Engineer | LinkedIn</title></head><body><h1>Mara Quill</h1><p>Staff Software Engineer at Google LLC</p></body></html>';
    const res = await sourcesApp(t, { fetch: okFetch(html) }).request(
      '/sources/linkedin',
      json({ url: 'https://linkedin.com/in/mara-quill/' }),
    );
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection).toMatchObject({ kind: 'linkedin', status: 'connected' });
    expect(connection.config.url).toBe('https://www.linkedin.com/in/mara-quill');
    expect(connection.config.text).toContain('Staff Software Engineer at Google LLC');
  });

  it('rejects URLs that are not linkedin.com/in/', async () => {
    const t = await env.makeTenant();
    const app = sourcesApp(t, { fetch: okFetch('x') });
    for (const url of [
      'https://example.com/in/mara',
      'https://linkedin.com.evil.test/in/mara',
      'https://www.linkedin.com/company/acme',
      'https://www.linkedin.com/in/',
      'ftp://linkedin.com/in/mara',
      'not a url',
    ]) {
      const res = await app.request('/sources/linkedin', json({ url }));
      expect(res.status, url).toBe(400);
      expect((await res.json()).code, url).toBe('invalid_linkedin_url');
    }
    expect(await getConnection(t.handle, t.userId, 'linkedin')).toBeNull();
  });

  it('degrades to partial on a login wall, a block and a timeout', async () => {
    const t = await env.makeTenant();
    const wall = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://www.linkedin.com/authwall?x=1' },
      })) as typeof fetch;
    const timeout = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as typeof fetch;
    for (const f of [wall, okFetch('', 999), timeout]) {
      const res = await sourcesApp(t, { fetch: f }).request(
        '/sources/linkedin',
        json({ url: 'https://www.linkedin.com/in/mara-quill' }),
      );
      expect(res.status).toBe(201);
      const { connection } = await res.json();
      expect(connection.status).toBe('partial');
      expect(connection.config.text).toBe('');
      expect(connection.config.url).toBe('https://www.linkedin.com/in/mara-quill');
    }
  });

  it('stores a GitHub username with public non-fork repos', async () => {
    const t = await env.makeTenant();
    const repos = [
      {
        name: 'tinyqueue',
        description: 'A small queue',
        language: 'TypeScript',
        pushed_at: '2025-08-02T10:00:00Z',
        fork: false,
      },
      {
        name: 'forked-lib',
        description: null,
        language: 'Go',
        pushed_at: '2024-01-01T00:00:00Z',
        fork: true,
      },
    ];
    const res = await sourcesApp(t, { fetch: okFetch(JSON.stringify(repos)) }).request(
      '/sources/github',
      json({ username: 'mara-quill' }),
    );
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection).toMatchObject({ kind: 'github', status: 'connected' });
    expect(connection.config.username).toBe('mara-quill');
    expect(connection.config.repos).toHaveLength(1);
    expect(connection.config.text).toContain(
      'mara-quill/tinyqueue: A small queue (TypeScript), pushed 2025-08',
    );
  });

  it('GitHub: unknown user is 400, rate limit or outage is partial, bad names are 400', async () => {
    const t = await env.makeTenant();
    const nf = await sourcesApp(t, { fetch: okFetch('{}', 404) }).request(
      '/sources/github',
      json({ username: 'nobody-here' }),
    );
    expect(nf.status).toBe(400);
    expect((await nf.json()).code).toBe('github_user_not_found');
    const limited = await sourcesApp(t, { fetch: okFetch('{}', 403) }).request(
      '/sources/github',
      json({ username: 'mara-quill' }),
    );
    expect(limited.status).toBe(201);
    expect((await limited.json()).connection.status).toBe('partial');
    const bad = await sourcesApp(t).request('/sources/github', json({ username: '-bad name' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_github_username');
  });

  const fakeDrive = (): DriveFolderPort => ({
    listFolders: async () => [
      { id: 'f1', name: 'Career' },
      { id: 'f2', name: 'Writing' },
    ],
  });

  it('drive picker lists only the folders the port returns', async () => {
    const t = await env.makeTenant();
    const res = await sourcesApp(t, { drive: fakeDrive() }).request('/sources/drive/folders');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [
        { id: 'f1', name: 'Career' },
        { id: 'f2', name: 'Writing' },
      ],
    });
  });

  it('drive picker is 409 drive_not_connected when Drive access is missing', async () => {
    const t = await env.makeTenant();
    const port: DriveFolderPort = {
      listFolders: async () => {
        throw new DriveNotConnectedError();
      },
    };
    const res = await sourcesApp(t, { drive: port }).request('/sources/drive/folders');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('drive_not_connected');
  });

  it('stores the selected folders on the drive connection', async () => {
    const t = await env.makeTenant();
    await upsertConnection(t.handle, {
      userId: t.userId,
      kind: 'drive',
      status: 'connected',
      config: {},
    });
    const res = await sourcesApp(t, { drive: fakeDrive() }).request(
      '/sources/drive',
      json({ folder_ids: ['f2', 'f2'] }),
    );
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection).toMatchObject({ kind: 'drive', status: 'connected' });
    expect(connection.config).toEqual({
      folder_ids: ['f2'],
      folders: [{ id: 'f2', name: 'Writing' }],
    });
  });

  it('drive selection: unknown folder is 400, no drive connection is 409, empty list is 400', async () => {
    const t = await env.makeTenant();
    const app = sourcesApp(t, { drive: fakeDrive() });
    expect((await app.request('/sources/drive', json({ folder_ids: ['f1'] }))).status).toBe(409);
    await upsertConnection(t.handle, {
      userId: t.userId,
      kind: 'drive',
      status: 'connected',
      config: {},
    });
    const unknown = await app.request('/sources/drive', json({ folder_ids: ['zzz'] }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe('unknown_folder');
    const empty = await app.request('/sources/drive', json({ folder_ids: [] }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).code).toBe('validation');
  });
});

describe('disconnect', () => {
  it('deletes the resume file, marks it disconnected, and excludes it from builds', async () => {
    const t = await env.makeTenant();
    const app = appFor(t, {
      '/sources': createSourcesRoutes({ fileStoreDir: () => storeDir }),
      '/profile': createProfileRoutes({
        queue: { enqueueProfileBuild: async () => {}, jobState: async () => 'created' },
      }),
    });
    await upload(app, await fx('resume.pdf'), 'cv.pdf', 'application/pdf');
    const file = join(storeDir, t.id, t.userId, 'resume.pdf');
    expect(existsSync(file)).toBe(true);
    expect((await listActiveConnections(t.handle, t.userId)).map((c) => c.kind)).toEqual([
      'resume',
    ]);

    const res = await app.request('/sources/resume', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(existsSync(file)).toBe(false);
    const row = await getConnection(t.handle, t.userId, 'resume');
    expect(row).toMatchObject({ status: 'disconnected', fileRef: null, config: {} });
    expect(row?.disconnectedAt).toBeInstanceOf(Date);
    expect(await listActiveConnections(t.handle, t.userId)).toEqual([]);
    const build = await app.request('/profile/build', { method: 'POST' });
    expect(build.status).toBe(409);
    expect((await build.json()).code).toBe('no_resume');
    const actions = (await activity.listByUser(t.handle, t.userId)).map((a) => a.action);
    expect(actions).toContain('source_disconnected');
  });

  it('removes cached config for linkedin, github and drive; idempotent; rejects other kinds', async () => {
    const t = await env.makeTenant();
    const app = sourcesApp(t);
    await upsertConnection(t.handle, {
      userId: t.userId,
      kind: 'linkedin',
      config: { url: 'u', text: 'secret-ish' },
    });
    await upsertConnection(t.handle, {
      userId: t.userId,
      kind: 'github',
      config: { username: 'x', text: 'y' },
    });
    await upsertConnection(t.handle, {
      userId: t.userId,
      kind: 'drive',
      config: { folder_ids: ['f1'] },
    });
    for (const kind of ['linkedin', 'github', 'drive']) {
      expect((await app.request(`/sources/${kind}`, { method: 'DELETE' })).status).toBe(204);
      const row = await getConnection(t.handle, t.userId, kind as 'drive');
      expect(row).toMatchObject({ status: 'disconnected', config: {} });
    }
    expect((await app.request('/sources/linkedin', { method: 'DELETE' })).status).toBe(204);
    expect((await app.request('/sources/resume', { method: 'DELETE' })).status).toBe(204);
    expect((await app.request('/sources/gmail', { method: 'DELETE' })).status).toBe(400);
  });

  it('reconnecting after a disconnect reuses the row and clears disconnected_at', async () => {
    const t = await env.makeTenant();
    const app = sourcesApp(t, { fetch: okFetch('[]') });
    await app.request('/sources/github', json({ username: 'mara-quill' }));
    await app.request('/sources/github', { method: 'DELETE' });
    await app.request('/sources/github', json({ username: 'mara-quill' }));
    const row = await getConnection(t.handle, t.userId, 'github');
    expect(row?.disconnectedAt).toBeNull();
    expect(row?.status).toBe('partial'); // no repos returned
  });
});
