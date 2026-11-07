import { Hono, type Context } from 'hono';
import {
  getApplication,
  getInterview,
  listInterviewsForApplication,
  llmUsageForApplication,
  type TenantHandle,
} from '@wma/db';
import type { AppEnv } from '../middleware/session';
import {
  EMPTY_FEEDBACK_MESSAGE,
  FeedbackInput,
  saveFeedback,
  type SaveFeedbackResult,
} from '../services/feedback';
import {
  pgBossPrepQueue,
  requestNegotiation,
  requestPrepPlan,
  toInterviewView,
  type PrepQueue,
} from '../services/prep';
import { invalidJson, readJson, validationError } from '../services/http';
import { isUuid } from '../services/uuid';

export interface InterviewsDeps {
  queue?: PrepQueue;
  now?: () => Date;
}

/** The offer panel data stored on the application, passed through untouched except for shape. */
function negotiationView(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  return {
    posted_min: typeof n.posted_min === 'number' ? n.posted_min : null,
    posted_max: typeof n.posted_max === 'number' ? n.posted_max : null,
    currency: typeof n.currency === 'string' ? n.currency : null,
    floor: typeof n.floor === 'number' ? n.floor : null,
    comparables: Array.isArray(n.comparables) ? n.comparables : [],
    fetched_at: typeof n.fetched_at === 'string' ? n.fetched_at : null,
    error: typeof n.error === 'string' ? n.error : null,
  };
}

const notFound = { code: 'not_found', message: 'Interview not found.' } as const;

/** Mounted at /api/interviews behind requireSession. */
export function createInterviewsRoutes(deps: InterviewsDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Everything the card needs besides the board data: its interviews and the offer panel.
  app.get('/for-application/:applicationId', async (c) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('applicationId');
    const application = isUuid(id) ? await getApplication(handle, id) : null;
    if (!application || application.userId !== userId)
      return c.json({ code: 'not_found', message: 'Application not found.' }, 404);
    const [interviews, llmUsage] = await Promise.all([
      listInterviewsForApplication(handle, application.id),
      llmUsageForApplication(handle, application.id),
    ]);
    return c.json({
      interviews: interviews.map(toInterviewView),
      negotiation: negotiationView(application.negotiation),
      // What the agent spent on this application so far (tokens and estimated USD).
      llm_usage: llmUsage,
    });
  });

  app.post('/for-application/:applicationId/negotiation', async (c) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('applicationId');
    if (!isUuid(id)) return c.json({ code: 'not_found', message: 'Application not found.' }, 404);
    const r = await requestNegotiation(handle, userId, id, deps.queue ?? pgBossPrepQueue);
    switch (r.status) {
      case 'not_found':
        return c.json({ code: 'not_found', message: 'Application not found.' }, 404);
      case 'not_offer':
        return c.json({ code: 'not_offer', message: 'This application has no offer.' }, 409);
      default:
        return c.json({ status: 'queued', enqueued: r.enqueued }, 202);
    }
  });

  async function owned(handle: TenantHandle, userId: string, id: string) {
    const row = isUuid(id) ? await getInterview(handle, id) : null;
    return row && row.userId === userId ? row : null;
  }

  app.get('/:id', async (c) => {
    const { handle, userId } = c.get('session');
    const row = await owned(handle, userId, c.req.param('id'));
    if (!row) return c.json(notFound, 404);
    return c.json({ interview: toInterviewView(row) });
  });

  const feedback = (mode: 'create' | 'edit') => async (c: Context<AppEnv>) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('id') ?? '';
    if (!(await owned(handle, userId, id))) return c.json(notFound, 404);
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = FeedbackInput.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    const now = deps.now?.() ?? c.get('now')?.() ?? new Date();
    const result: SaveFeedbackResult = await saveFeedback(
      handle,
      userId,
      id,
      mode,
      parsed.data,
      now,
    );
    switch (result.status) {
      case 'saved':
        return c.json({ feedback: result.feedback }, result.created ? 201 : 200);
      case 'empty':
        return c.json({ code: 'empty_feedback', message: EMPTY_FEEDBACK_MESSAGE }, 400);
      case 'exists':
        return c.json(
          { code: 'feedback_exists', message: 'Feedback was already submitted; edit it instead.' },
          409,
        );
      case 'no_feedback':
        return c.json({ code: 'no_feedback', message: 'There is no feedback to edit yet.' }, 404);
      default:
        return c.json(notFound, 404);
    }
  };
  app.post('/:id/feedback', feedback('create'));
  app.put('/:id/feedback', feedback('edit'));

  app.post('/:id/prep-plan', async (c) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json(notFound, 404);
    const r = await requestPrepPlan(handle, userId, id, deps.queue ?? pgBossPrepQueue);
    switch (r.status) {
      case 'not_found':
        return c.json(notFound, 404);
      case 'not_actionable':
        return c.json(
          {
            code: 'not_actionable',
            message: 'This application is closed, so no plan is prepared.',
          },
          409,
        );
      default:
        return c.json({ status: 'pending', enqueued: r.enqueued }, r.enqueued ? 202 : 200);
    }
  });

  return app;
}

export const interviewsRoutes = createInterviewsRoutes();
