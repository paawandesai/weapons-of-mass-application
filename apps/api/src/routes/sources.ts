import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { activity, getConnection, updateConnection, upsertConnection } from '@wma/db';
import type { AppEnv } from '../middleware/session';
import { cleanText, isProfileSourceKind, toConnection } from '../services/connections';
import {
  DriveNotConnectedError,
  googleDriveFolders,
  type DriveFolderPort,
} from '../services/drive';
import { fetchGithub, isGithubUsername } from '../services/github';
import { badRequest, invalidJson, readJson, validationError } from '../services/http';
import { fetchLinkedinText, normalizeLinkedinUrl } from '../services/linkedin';
import {
  disconnectSource,
  MAX_RESUME_BYTES,
  prepareResume,
  replaceResume,
  ResumeError,
} from '../services/resume';

/** Multipart framing overhead allowed on top of the 10 MB file; enforced on the stream itself. */
const MAX_RESUME_BODY_BYTES = MAX_RESUME_BYTES + 256 * 1024;

export interface SourcesDeps {
  /** Directory resumes are stored under. Defaults to FILE_STORE_DIR at request time. */
  fileStoreDir?: () => string;
  fetch?: typeof fetch;
  drive?: DriveFolderPort;
}

const folderIdsSchema = z.object({
  folder_ids: z.array(z.string().min(1)).min(1).max(50),
});

export function createSourcesRoutes(deps: SourcesDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const storeDir = () =>
    (deps.fileStoreDir ?? (() => process.env.FILE_STORE_DIR ?? './data/files'))();
  const drive = () => deps.drive ?? googleDriveFolders;

  const log = (
    c: { get(k: 'session'): AppEnv['Variables']['session'] },
    action: string,
    kind: string,
  ) => {
    const { handle, userId } = c.get('session');
    return activity.logActivity(handle, { userId, actor: 'user', action, detail: { kind } });
  };

  app.post(
    '/resume',
    // Counts the bytes actually received (not the Content-Length header), so a chunked body of any
    // size is cut off here, before multipart parsing buffers it.
    bodyLimit({
      maxSize: MAX_RESUME_BODY_BYTES,
      onError: (c) => badRequest(c, 'too_large', 'The file is larger than 10 MB.'),
    }),
    async (c) => {
      const { handle, userId, tenantId } = c.get('session');
      let body: Record<string, unknown>;
      try {
        body = await c.req.parseBody();
      } catch {
        return badRequest(c, 'validation', 'Expected multipart form data with a "file" field.');
      }
      const file = body.file;
      if (!(file instanceof File)) {
        return c.json(
          {
            code: 'validation',
            message: 'Invalid request',
            issues: [{ path: ['file'], message: 'required' }],
          },
          400,
        );
      }
      if (file.size > MAX_RESUME_BYTES)
        return badRequest(c, 'too_large', 'The file is larger than 10 MB.');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const prepared = await prepareResume({ filename: file.name, mime: file.type, bytes });
        const row = await replaceResume({
          handle,
          storeDir: storeDir(),
          tenantId,
          userId,
          prepared,
          bytes,
        });
        await log(c, 'source_connected', 'resume');
        return c.json({ connection: toConnection(row) }, 201);
      } catch (e) {
        if (e instanceof ResumeError) return badRequest(c, e.code, e.message);
        throw e;
      }
    },
  );

  app.post('/linkedin', async (c) => {
    const { handle, userId } = c.get('session');
    const body = await readJson(c);
    if (body === undefined) return invalidJson(c);
    const parsed = z.object({ url: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error);
    const url = normalizeLinkedinUrl(parsed.data.url);
    if (!url) {
      return badRequest(
        c,
        'invalid_linkedin_url',
        'Enter a LinkedIn profile URL like linkedin.com/in/your-name.',
      );
    }
    const page = await fetchLinkedinText(url, { fetch: deps.fetch });
    const row = await upsertConnection(handle, {
      userId,
      kind: 'linkedin',
      status: page.outcome === 'ok' ? 'connected' : 'partial',
      config: { url, text: page.text, fetch: page.outcome, fetched_at: new Date().toISOString() },
    });
    await log(c, 'source_connected', 'linkedin');
    return c.json({ connection: toConnection(row) }, 201);
  });

  app.post('/github', async (c) => {
    const { handle, userId } = c.get('session');
    const body = await readJson(c);
    if (body === undefined) return invalidJson(c);
    const parsed = z.object({ username: z.string().trim().min(1) }).safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error);
    const username = parsed.data.username.replace(/^@/, '');
    if (!isGithubUsername(username)) {
      return badRequest(c, 'invalid_github_username', 'That is not a valid GitHub username.');
    }
    const result = await fetchGithub(username, { fetch: deps.fetch });
    if (result.outcome === 'not_found') {
      return badRequest(c, 'github_user_not_found', 'No GitHub user with that name.');
    }
    const ok = result.outcome === 'ok';
    const row = await upsertConnection(handle, {
      userId,
      kind: 'github',
      status: ok && result.repos.length > 0 ? 'connected' : 'partial',
      config: {
        username,
        repos: ok ? result.repos : [],
        text: ok ? cleanText(result.text, 60_000) : '',
        fetched_at: new Date().toISOString(),
      },
    });
    await log(c, 'source_connected', 'github');
    return c.json({ connection: toConnection(row) }, 201);
  });

  app.get('/drive/folders', async (c) => {
    const { handle, userId } = c.get('session');
    try {
      const folders = await drive().listFolders(handle, userId);
      return c.json({ folders: folders.map((f) => ({ id: f.id, name: f.name })) });
    } catch (e) {
      if (e instanceof DriveNotConnectedError) {
        return c.json(
          { code: 'drive_not_connected', message: 'Connect Google Drive to pick folders.' },
          409,
        );
      }
      throw e;
    }
  });

  app.post('/drive', async (c) => {
    const { handle, userId } = c.get('session');
    const body = await readJson(c);
    if (body === undefined) return invalidJson(c);
    const parsed = folderIdsSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error);
    const existing = await getConnection(handle, userId, 'drive');
    if (!existing || existing.status === 'disconnected') {
      return c.json(
        { code: 'drive_not_connected', message: 'Connect Google Drive to pick folders.' },
        409,
      );
    }
    let folders;
    try {
      folders = await drive().listFolders(handle, userId);
    } catch (e) {
      if (e instanceof DriveNotConnectedError) {
        return c.json(
          { code: 'drive_not_connected', message: 'Connect Google Drive to pick folders.' },
          409,
        );
      }
      throw e;
    }
    const byId = new Map(folders.map((f) => [f.id, f]));
    const ids = [...new Set(parsed.data.folder_ids)];
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return badRequest(
        c,
        'unknown_folder',
        'One or more selected folders could not be found in Drive.',
      );
    }
    const row = await updateConnection(handle, userId, 'drive', {
      status: 'connected',
      config: { folder_ids: ids, folders: ids.map((id) => ({ id, name: byId.get(id)!.name })) },
    });
    await log(c, 'source_connected', 'drive');
    return c.json({ connection: toConnection(row!) }, 201);
  });

  app.delete('/:kind', async (c) => {
    const { handle, userId } = c.get('session');
    const kind = c.req.param('kind');
    if (!isProfileSourceKind(kind)) {
      return badRequest(c, 'unsupported_kind', 'That source cannot be disconnected here.');
    }
    const previous = await disconnectSource({ handle, storeDir: storeDir(), userId, kind });
    if (previous) await log(c, 'source_disconnected', kind);
    return c.body(null, 204);
  });

  return app;
}

export const sourcesRoutes = createSourcesRoutes();
