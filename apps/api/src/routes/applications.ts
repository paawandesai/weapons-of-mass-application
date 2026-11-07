import { Hono } from 'hono';
import {
  activity,
  getApplication,
  getJob,
  listApplications,
  listCaptchaRequestsForApplication,
  listCompaniesByIds,
  listJobsByIds,
  type ApplicationRow,
  type CaptchaRequestRow,
  type JobRow,
} from '@wma/db';
import { ApplicationStatus } from '@wma/shared';
import type { AppEnv } from '../middleware/session';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const applicationsRoutes = new Hono<AppEnv>();

function summary(row: ApplicationRow, job: JobRow | undefined, company: string | null) {
  return {
    id: row.id,
    status: row.status,
    pending_reason: row.pendingReason,
    closed_reason: row.closedReason,
    attempt_count: row.attemptCount,
    applied_at: iso(row.appliedAt),
    last_activity_at: row.lastActivityAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    job: job ? { id: job.id, title: job.title, url: job.url, ats: job.ats, company } : null,
  };
}

/** `form_answers` is keyed by question: a value, null for a blank, or {skipped} / {attached}. */
function answerList(raw: unknown) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).map(([question, value]) => {
    if (value === null) return { question, status: 'blank', value: null };
    if (typeof value === 'object' && !Array.isArray(value)) {
      const v = value as { skipped?: string; attached?: string };
      if (v.skipped) return { question, status: 'skipped', value: null, skipped: v.skipped };
      if (v.attached) return { question, status: 'attached', value: v.attached };
    }
    return { question, status: 'filled', value };
  });
}

function captchaSummary(row: CaptchaRequestRow) {
  const attempts = row.attempts as Record<string, number>;
  return {
    id: row.id,
    stage: row.stage,
    resolved_by: row.resolvedBy,
    attempts: {
      agent1: attempts.agent1 ?? 0,
      agent2: attempts.agent2 ?? 0,
      human: attempts.human ?? 0,
    },
    created_at: row.createdAt.toISOString(),
    resolved_at: iso(row.resolvedAt),
    expired_at: iso(row.expiredAt),
  };
}

applicationsRoutes.get('/', async (c) => {
  const { handle, userId } = c.get('session');
  const requested = (c.req.queries('status') ?? [])
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed = requested.map((s) => ApplicationStatus.safeParse(s));
  if (parsed.some((p) => !p.success)) {
    return c.json({ code: 'bad_request', message: 'Unknown status' }, 400);
  }
  const rows = await listApplications(handle, userId, {
    status: parsed.map((p) => p.data!),
  });
  const jobs = new Map(
    (await listJobsByIds(handle, [...new Set(rows.map((r) => r.jobId))])).map((j) => [j.id, j]),
  );
  const companyIds = [
    ...new Set([...jobs.values()].map((j) => j.companyId).filter((id): id is string => !!id)),
  ];
  const companies = new Map(
    (await listCompaniesByIds(handle, companyIds)).map((co) => [co.id, co.name]),
  );
  return c.json({
    applications: rows.map((r) => {
      const job = jobs.get(r.jobId);
      return summary(r, job, job?.companyId ? (companies.get(job.companyId) ?? null) : null);
    }),
  });
});

applicationsRoutes.get('/:id', async (c) => {
  const { handle, userId } = c.get('session');
  const id = c.req.param('id');
  const row = UUID_RE.test(id) ? await getApplication(handle, id) : null;
  if (!row || row.userId !== userId) {
    return c.json({ code: 'not_found', message: 'Application not found' }, 404);
  }
  const job = await getJob(handle, row.jobId);
  const company = job?.companyId
    ? (await listCompaniesByIds(handle, [job.companyId]))[0]
    : undefined;
  const entries = (await activity.listByApplication(handle, row.id, { limit: 200 })).reverse();
  const captcha = (await listCaptchaRequestsForApplication(handle, row.id)).reverse();
  return c.json({
    ...summary(row, job ?? undefined, company?.name ?? null),
    confirmation_source: row.confirmationSource,
    resume: row.resumePdfRef ? { ref: row.resumePdfRef } : null,
    form_answers: answerList(row.formAnswers),
    unmet_requirements: Array.isArray(row.unmetRequirements) ? row.unmetRequirements : [],
    activity: entries.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      actor: e.actor,
      action: e.action,
      detail: e.detail,
    })),
    captcha: captcha.map(captchaSummary),
  });
});
