import { Hono } from 'hono';
import type { AppEnv } from '../middleware/session';
import { buildBoard } from '../services/board';

/** Mounted at /api/board behind requireSession. */
export const boardRoutes = new Hono<AppEnv>();

boardRoutes.get('/', async (c) => {
  const { handle, userId } = c.get('session');
  return c.json(await buildBoard(handle, userId));
});
