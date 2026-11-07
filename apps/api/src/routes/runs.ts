import { Hono } from 'hono';
import { getLatestRun, getRun } from '@wma/db';
import type { AppEnv } from '../middleware/session';
import { isUuid } from '../services/uuid';
import { pgBossRunQueue, requestRun, runResponse, type RunQueue } from '../services/discovery';

export interface RunsDeps {
  queue?: RunQueue;
}

export function createRunsRoutes(deps: RunsDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const { handle, userId } = c.get('session');
    const now = c.get('now')?.() ?? new Date();
    const result = await requestRun(handle, userId, deps.queue ?? pgBossRunQueue, now);
    const body = await runResponse(handle, result.run);
    if (result.run.dispatchState === 'failed' && result.run.step === 'queued') {
      // The row exists but the worker never received it; the next trigger sends it again.
      return c.json(
        {
          code: 'dispatch_failed',
          message: 'Your run could not be started just now. Try again in a moment.',
          ...body,
        },
        503,
      );
    }
    // 202: handed to the worker (new run, or a dispatch that failed earlier was retried);
    // 200: the run that already exists for today, or an immediate skip.
    return c.json(body, result.queued ? 202 : 200);
  });

  app.get('/latest', async (c) => {
    const { handle, userId } = c.get('session');
    const run = await getLatestRun(handle, userId);
    if (!run) return c.json({ code: 'no_run', message: 'No runs yet.' }, 404);
    return c.json(await runResponse(handle, run));
  });

  app.get('/:id', async (c) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('id');
    const run = isUuid(id) ? await getRun(handle, id) : null;
    if (!run || run.userId !== userId)
      return c.json({ code: 'not_found', message: 'Run not found.' }, 404);
    return c.json(await runResponse(handle, run));
  });

  return app;
}

export const runsRoutes = createRunsRoutes();
