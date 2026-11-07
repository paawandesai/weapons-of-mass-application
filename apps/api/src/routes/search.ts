import { Hono } from 'hono';
import type { AppEnv } from '../middleware/session';
import { SEARCH_MIN_CHARS, searchCompanies } from '../services/board';

/** Mounted at /api/search behind requireSession. */
export const searchRoutes = new Hono<AppEnv>();

searchRoutes.get('/companies', async (c) => {
  const { handle, userId } = c.get('session');
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < SEARCH_MIN_CHARS) {
    return c.json(
      { code: 'bad_request', message: `Type at least ${SEARCH_MIN_CHARS} characters.` },
      400,
    );
  }
  return c.json({ results: await searchCompanies(handle, userId, q) });
});
