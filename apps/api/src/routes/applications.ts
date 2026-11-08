import { Hono } from 'hono';
import { z } from 'zod';
import {
  activity,
  changeStageByUser,
  fileStoreDir,
  getApplication,
  getCurrentTenant,
  getFile,
  getJob,
  listApplications,
  listCaptchaRequestsForApplication,
  listCompaniesByIds,
  listDemoThread,
  listEmailThreadsForApplication,
  listInterviewsForApplication,
  listJobsByIds,
  listOutgoingMessagesForApplication,
  listRunCandidates,
  listSlotsForInterview,
  recordFollowOnJob,
  type ApplicationRow,
  type InterviewRow,
  type InterviewSlotRow,
  type CaptchaRequestRow,
  type JobRow,
  type TenantHandle,
} from '@wma/db';
import { ApplicationStatus, negotiationKey, NEGOTIATION_JOB } from '@wma/shared';
import type { AppEnv } from '../middleware/session';
import { invalidJson, readJson, validationError } from '../services/http';

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
    job: job
      ? {
          id: job.id,
          title: job.title,
          url: job.url,
          ats: job.ats,
          company,
          location: job.location,
          location_mode: job.locationMode,
          pay_min: job.payMin,
          pay_max: job.payMax,
          currency: job.currency,
          posted_at: iso(job.postedAt),
        }
      : null,
  };
}

const ACTIVITY_PAGE = 50;

function encodeCursor(c: activity.ActivityCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(raw: string): activity.ActivityCursor | null {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof v.at !== 'string' || typeof v.id !== 'string' || !UUID_RE.test(v.id)) return null;
    if (Number.isNaN(Date.parse(v.at))) return null;
    return { at: v.at, id: v.id };
  } catch {
    return null;
  }
}

type SlotState = 'confirmed' | 'invalidated' | 'expired' | 'open';
function slotView(s: InterviewSlotRow, now: Date) {
  const state: SlotState = s.confirmedAt
    ? 'confirmed'
    : s.invalidatedAt
      ? 'invalidated'
      : s.expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : 'open';
  // The token hash never leaves the server.
  return { id: s.id, starts_at: s.startsAt.toISOString(), ends_at: s.endsAt.toISOString(), state };
}

function interviewView(row: InterviewRow, slots: InterviewSlotRow[], now: Date) {
  return {
    id: row.id,
    thread_id: row.threadId,
    starts_at: iso(row.startsAt),
    ends_at: iso(row.endsAt),
    confirmed_at: iso(row.confirmedAt),
    booked: row.bookedGeneration !== null,
    slots: slots.map((s) => slotView(s, now)),
    prep_plan_status: row.prepPlanStatus,
    prep_plan: row.prepPlan,
    feedback: row.feedback ?? null,
  };
}

/** The judgment's rationale from the run that selected the job; null once the run is purged. */
async function decisionFor(
  handle: TenantHandle,
  row: ApplicationRow,
  job: JobRow | null,
): Promise<{ rationale: string; seniority: string | null } | null> {
  if (!row.runId || !job) return null;
  const candidates = await listRunCandidates(handle, row.runId);
  const match = candidates.find(
    (c) =>
      c.url === job.url ||
      (!!job.ats && !!job.atsJobId && c.ats === job.ats && c.atsJobId === job.atsJobId),
  );
  const j = match?.judgment as { rationale?: unknown; seniority?: unknown } | null | undefined;
  if (!j || typeof j.rationale !== 'string') return null;
  return {
    rationale: j.rationale,
    seniority: typeof j.seniority === 'string' ? j.seniority : null,
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
      // Rule 30: an inferred or guessed answer is stored as {value, source}.
      const w = value as { value?: unknown; source?: unknown };
      if ('value' in w && (w.source === 'inferred' || w.source === 'guessed')) {
        return { question, status: 'filled', value: w.value, source: w.source };
      }
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
  const rawBefore = c.req.query('activity_before');
  let before: activity.ActivityCursor | undefined;
  if (rawBefore) {
    before = decodeCursor(rawBefore) ?? undefined;
    if (!before) return c.json({ code: 'bad_request', message: 'Invalid activity cursor' }, 400);
  }
  const now = c.get('now')?.() ?? new Date();
  const job = await getJob(handle, row.jobId);
  const company = job?.companyId
    ? (await listCompaniesByIds(handle, [job.companyId]))[0]
    : undefined;
  const page = await activity.listByApplication(handle, row.id, { limit: ACTIVITY_PAGE, before });
  const entries = [...page].reverse();
  const captcha = (await listCaptchaRequestsForApplication(handle, row.id)).reverse();
  const decision = await decisionFor(handle, row, job);

  const threads = await listEmailThreadsForApplication(handle, row.id);
  // Bodies are only held locally for the simulated mailbox, which only the flagged demo tenant
  // reads; every other tenant's mail stays in Gmail and card detail shows the stored subject only.
  const isDemo = threads.length > 0 && (await getCurrentTenant(handle)).demo;
  const threadViews = await Promise.all(
    threads.map(async (t) => {
      const messages = isDemo ? await listDemoThread(handle, t.gmailThreadId) : [];
      return {
        id: t.id,
        subject: t.subject ?? messages[0]?.subject ?? null,
        kind: t.kind,
        compensation_flag: t.compensationFlag,
        booking_link: t.bookingLink,
        last_message_at: t.lastMessageAt.toISOString(),
        messages: messages.map((m) => ({
          id: m.gmailMessageId,
          from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
          at: m.internalDate.toISOString(),
          body: m.bodyText,
        })),
      };
    }),
  );
  const sent = (await listOutgoingMessagesForApplication(handle, row.id)).reverse();

  const interviewRows = await listInterviewsForApplication(handle, row.id);
  const interviews = await Promise.all(
    interviewRows.map(async (i) =>
      interviewView(i, await listSlotsForInterview(handle, i.id), now),
    ),
  );
  const planned = [...interviews].reverse().find((i) => i.prep_plan_status !== null);

  return c.json({
    ...summary(row, job ?? undefined, company?.name ?? null),
    confirmation_source: row.confirmationSource,
    decision,
    resume: row.resumePdfRef ? { ref: row.resumePdfRef } : null,
    form_answers: answerList(row.formAnswers),
    unmet_requirements: Array.isArray(row.unmetRequirements) ? row.unmetRequirements : [],
    threads: threadViews,
    outgoing: sent.map((m) => ({
      id: m.id,
      kind: m.kind,
      subject: m.subject,
      state: m.state,
      sent_at: iso(m.sentAt),
    })),
    activity: entries.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      actor: e.actor,
      action: e.action,
      detail: e.detail,
    })),
    activity_next:
      page.length === ACTIVITY_PAGE ? encodeCursor(page[page.length - 1]!.cursor) : null,
    interviews,
    prep_plan: planned
      ? { interview_id: planned.id, status: planned.prep_plan_status, text: planned.prep_plan }
      : null,
    feedback: [...interviews].reverse().find((i) => i.feedback)?.feedback ?? null,
    negotiation: row.negotiation ?? null,
    captcha: captcha.map(captchaSummary),
  });
});

/** A download name from company and title: ASCII, no quotes or path characters, bounded. */
function resumeFileName(company: string | null, title: string | null): string {
  const clean = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\/:*?<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  const parts = [company, title].map((p) => (p ? clean(p) : '')).filter(Boolean);
  return `Resume - ${parts.join(' - ') || 'application'}.pdf`;
}

/** The tailored resume that was submitted, as a PDF download. */
applicationsRoutes.get('/:id/resume', async (c) => {
  const { handle, userId } = c.get('session');
  const id = c.req.param('id');
  const row = UUID_RE.test(id) ? await getApplication(handle, id) : null;
  if (!row || row.userId !== userId || !row.resumePdfRef) {
    return c.json({ code: 'not_found', message: 'No resume for this application' }, 404);
  }
  const bytes = await getFile(handle, row.resumePdfRef, fileStoreDir());
  if (!bytes) {
    return c.json({ code: 'not_found', message: 'The resume file is no longer available' }, 404);
  }
  const job = await getJob(handle, row.jobId);
  const company = job?.companyId
    ? (await listCompaniesByIds(handle, [job.companyId]))[0]
    : undefined;
  const name = resumeFileName(company?.name ?? null, job?.title ?? null);
  return c.body(new Uint8Array(bytes), 200, {
    'Content-Type': 'application/pdf',
    'Content-Length': String(bytes.byteLength),
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
});

const StageBody = z.object({
  from: ApplicationStatus,
  to: ApplicationStatus.refine((s) => s !== 'pending', 'a card cannot be moved back to pending'),
});

/** A user's board move (design rule 2): conditional on the status the client saw. */
applicationsRoutes.post('/:id/stage', async (c) => {
  const { handle, userId } = c.get('session');
  const id = c.req.param('id');
  if (!UUID_RE.test(id))
    return c.json({ code: 'not_found', message: 'Application not found' }, 404);
  const raw = await readJson(c);
  if (raw === undefined) return invalidJson(c);
  const body = StageBody.safeParse(raw);
  if (!body.success) return validationError(c, body.error);
  // A move into Offer records the pay-data job in the same transaction as the move; the
  // reconciler sends it to the queue.
  const intoOffer = body.data.to === 'offer' && body.data.from !== 'offer';
  const data = { tenantId: handle.tenantId, userId, applicationId: id };
  const result = await handle.transaction(async (h) => {
    const r = await changeStageByUser(h, {
      userId,
      applicationId: id,
      from: body.data.from,
      to: body.data.to,
    });
    if (r.ok && intoOffer) {
      await recordFollowOnJob(h, {
        userId,
        kind: NEGOTIATION_JOB,
        payload: data,
        dedupeKey: negotiationKey(id),
      });
    }
    return r;
  });
  if (result.ok) return c.json({ id, status: body.data.to });
  if (result.current === null) {
    return c.json({ code: 'not_found', message: 'Application not found' }, 404);
  }
  return c.json(
    {
      code: 'stage_conflict',
      message: 'This card was updated elsewhere. The board has been refreshed.',
      current: result.current,
    },
    409,
  );
});
