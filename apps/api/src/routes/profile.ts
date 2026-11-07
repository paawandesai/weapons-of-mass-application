import { Hono } from 'hono';
import { z } from 'zod';
import { activity } from '@wma/db';
import { profileDocumentSchema } from '@wma/shared';
import type { AppEnv } from '../middleware/session';
import { getBuildStatus, hasResume, requestProfileBuild } from '../services/builds';
import { invalidJson, readJson, validationError } from '../services/http';
import { pgBossQueue, type BuildQueue } from '../services/queue';
import { approveProfileVersion, getProfileResponse, saveProfileDocument } from '../services/review';

export interface ProfileDeps {
  queue?: BuildQueue;
}

export function createProfileRoutes(deps: ProfileDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/build', async (c) => {
    const { handle, userId } = c.get('session');
    if (!(await hasResume(handle, userId))) {
      return c.json(
        { code: 'no_resume', message: 'Upload a resume before building your profile.' },
        409,
      );
    }
    const jobId = await requestProfileBuild(handle, userId, deps.queue ?? pgBossQueue);
    await activity.logActivity(handle, {
      userId,
      actor: 'user',
      action: 'profile_build_requested',
      detail: { job_id: jobId },
    });
    return c.json({ job_id: jobId }, 202);
  });

  app.get('/build/status', async (c) => {
    const { handle, userId } = c.get('session');
    return c.json(await getBuildStatus(handle, userId, deps.queue ?? pgBossQueue));
  });

  app.get('/', async (c) => {
    const { handle, userId } = c.get('session');
    const body = await getProfileResponse(handle, userId);
    if (!body) return c.json({ code: 'no_profile', message: 'No profile yet.' }, 404);
    return c.json(body);
  });

  app.put('/', async (c) => {
    const { handle, userId } = c.get('session');
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = z.object({ document: profileDocumentSchema }).safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    const version = await saveProfileDocument(handle, userId, parsed.data.document);
    return c.json({ version });
  });

  app.post('/approve', async (c) => {
    const { handle, userId } = c.get('session');
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = z.object({ version: z.number().int().positive() }).safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    const r = await approveProfileVersion(handle, userId, parsed.data.version);
    if (r.ok) return c.json({ approved_version: r.approved_version, approved_at: r.approved_at });
    if (r.reason === 'no_profile')
      return c.json({ code: 'no_profile', message: 'No profile yet.' }, 404);
    if (r.reason === 'version_mismatch')
      return c.json(
        {
          code: 'version_mismatch',
          message: 'The profile changed since you opened it. Review the latest version.',
          latest_version: r.latest_version,
        },
        409,
      );
    return c.json(
      {
        code: 'unresolved_flags',
        message: 'Resolve the flagged items before approving.',
        flags: r.flags,
      },
      409,
    );
  });

  return app;
}

export const profileRoutes = createProfileRoutes();
