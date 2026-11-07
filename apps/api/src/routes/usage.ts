import { Hono } from 'hono';
import {
  listApplications,
  listCompaniesByIds,
  listJobsByIds,
  listRecentLlmUsage,
  llmUsageByApplication,
  llmUsageByPurpose,
  totalLlmUsage,
  type LlmUsageRow,
} from '@wma/db';
import type { LlmPurpose, LlmUsageCall, LlmUsageResponse } from '@wma/shared';
import type { AppEnv } from '../middleware/session';

/** Mounted at /api/usage behind requireSession: the signed-in user's model spend. */
export const usageRoutes = new Hono<AppEnv>();

const WINDOWS: Record<string, number | null> = {
  all: null,
  '7d': 7,
  '30d': 30,
};

function toCall(r: LlmUsageRow): LlmUsageCall {
  return {
    id: r.id,
    at: r.at.toISOString(),
    purpose: r.purpose as LlmPurpose,
    application_id: r.applicationId,
    model: r.model,
    prompt: r.prompt,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cache_creation_input_tokens: r.cacheCreationInputTokens,
    cache_read_input_tokens: r.cacheReadInputTokens,
    cost_usd: r.costUsd === null ? null : Number(r.costUsd),
    duration_ms: r.durationMs,
  };
}

/** `?window=all|7d|30d` (default all). Totals, per purpose, per application, and the last 50 calls. */
usageRoutes.get('/', async (c) => {
  const { handle, userId } = c.get('session');
  const windowKey = c.req.query('window') ?? 'all';
  if (!Object.hasOwn(WINDOWS, windowKey))
    return c.json({ code: 'validation', message: 'window must be all, 7d or 30d' }, 400);
  const days = WINDOWS[windowKey] ?? null;
  const now = c.get('now') ?? (() => new Date());
  const since = days === null ? undefined : new Date(now().getTime() - days * 86_400_000);
  const window = { since };

  const [total, byPurpose, byApp, recent] = await Promise.all([
    totalLlmUsage(handle, userId, window),
    llmUsageByPurpose(handle, userId, window),
    llmUsageByApplication(handle, userId, window),
    listRecentLlmUsage(handle, userId, 50),
  ]);

  // Label each application with its company and title. Rows whose application was since deleted
  // are not in the per-application list (their application_id is null).
  const apps = byApp.length ? await listApplications(handle, userId) : [];
  const appById = new Map(apps.map((a) => [a.id, a]));
  const jobs = await listJobsByIds(handle, [...new Set(apps.map((a) => a.jobId))]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const companyIds = jobs.map((j) => j.companyId).filter((id): id is string => id !== null);
  const companies = await listCompaniesByIds(handle, [...new Set(companyIds)]);
  const companyById = new Map(companies.map((co) => [co.id, co]));

  const body: LlmUsageResponse = {
    since: since ? since.toISOString() : null,
    total,
    by_purpose: byPurpose,
    by_application: byApp.map(({ applicationId, ...totals }) => {
      const app = appById.get(applicationId);
      const job = app ? jobById.get(app.jobId) : undefined;
      const company = job?.companyId ? companyById.get(job.companyId) : undefined;
      return {
        application_id: applicationId,
        company: company?.name ?? null,
        title: job?.title ?? null,
        status: app?.status ?? 'unknown',
        ...totals,
      };
    }),
    recent: recent.map(toCall),
  };
  return c.json(body);
});
