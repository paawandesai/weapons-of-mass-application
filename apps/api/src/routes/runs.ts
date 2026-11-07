import { Hono } from 'hono';
import { getLatestRun, getRun, getUserById, listRunCandidates } from '@wma/db';
import type { AppEnv } from '../middleware/session';
import { isUuid } from '../services/uuid';
import {
  pgBossRunQueue,
  requestRun,
  runResponse,
  toCandidateView,
  toRunView,
  type RunQueue,
} from '../services/discovery';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

/** Position after the last candidate a client has seen, tied to the run it was issued for. */
interface Cursor {
  run: string;
  rank: number | null;
  id: string;
}
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof c.run !== 'string' || typeof c.id !== 'string') return null;
    return { run: c.run, rank: typeof c.rank === 'number' ? c.rank : null, id: c.id };
  } catch {
    return null;
  }
}
/** Rank order: ranked rows by rank, unranked after them by id; the id breaks ties. */
const isAfter = (rank: number | null, id: string, c: Cursor) =>
  rank === c.rank ? id > c.id : c.rank === null ? false : rank === null ? true : rank > c.rank;

/** The next scheduled start: the user's run hour (UTC) at the top of the hour, after `now`. */
function nextRunAt(hour: number, now: Date): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

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

  // The in-progress run, or the latest one, with its candidates after `cursor` in rank order.
  app.get('/current', async (c) => {
    const { handle, userId } = c.get('session');
    const run = await getLatestRun(handle, userId);
    if (!run) {
      const user = await getUserById(handle, userId);
      const now = c.get('now')?.() ?? new Date();
      return c.json({
        run: null,
        candidates: [],
        next_cursor: null,
        has_more: false,
        next_run_at: user.approvedProfileVersion !== null ? nextRunAt(user.digestHour, now) : null,
      });
    }
    const cursor = decodeCursor(c.req.query('cursor'));
    const asked = Number(c.req.query('limit') ?? PAGE_DEFAULT);
    const limit = Math.min(
      Math.max(Number.isFinite(asked) ? Math.trunc(asked) : PAGE_DEFAULT, 1),
      PAGE_MAX,
    );
    const all = await listRunCandidates(handle, run.id);
    const after =
      cursor && cursor.run === run.id ? all.filter((r) => isAfter(r.rank, r.id, cursor)) : all;
    const page = after.slice(0, limit);
    const last = page.at(-1);
    const own = cursor && cursor.run === run.id ? cursor : null;
    return c.json({
      run: toRunView(run),
      candidates: page.map(toCandidateView),
      next_cursor: last
        ? encodeCursor({ run: run.id, rank: last.rank, id: last.id })
        : own
          ? encodeCursor(own)
          : null,
      has_more: after.length > page.length,
      next_run_at: null,
    });
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
