import { Hono } from 'hono';
import { z } from 'zod';
import {
  activity,
  approveOutreachDraft,
  countOutreachSentSince,
  editOutreachDraft,
  getApplication,
  getUserById,
  insertPendingJob,
  listOutreachDrafts,
  outreachContentHash,
  rejectOutreachDraft,
  type OutreachDraftRow,
} from '@wma/db';
import {
  DRAFT_OUTREACH_JOB,
  MAX_LINKEDIN_NOTE,
  MAX_OUTREACH_BODY,
  MAX_OUTREACH_SUBJECT,
  OUTREACH_DAILY_CAP,
  SEND_OUTREACH_JOB,
  type DraftOutreachData,
  type OutreachDraftView,
  type OutreachListResponse,
  type SendOutreachData,
} from '@wma/shared';
import type { AppEnv } from '../middleware/session';
import { invalidJson, readJson, validationError } from '../services/http';
import { isUuid } from '../services/uuid';

const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function toDraftView(r: OutreachDraftRow): OutreachDraftView {
  return {
    id: r.id,
    application_id: r.applicationId,
    contact_name: r.contactName,
    contact_title: r.contactTitle,
    contact_profile_url: r.contactProfileUrl,
    to_address: r.toAddress,
    subject: r.subject,
    body_text: r.bodyText,
    linkedin_note: r.linkedinNote,
    state: r.state,
    content_hash: outreachContentHash(r),
    approved_at: r.approvedAt?.toISOString() ?? null,
    sent_at: r.sentAt?.toISOString() ?? null,
    failure_reason: r.failureReason,
    created_at: r.createdAt.toISOString(),
  };
}

const email = z.string().trim().toLowerCase().email().max(254);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const profileUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) link')
  .nullish()
  .transform((v) => v ?? null);

const CreateInput = z.object({
  application_id: z.string(),
  contact: z.object({
    name: z.string().trim().min(1).max(120),
    title: optionalText(160),
    profile_url: profileUrl,
    email,
  }),
});

const EditInput = z
  .object({
    to_address: email,
    subject: z.string().trim().min(1).max(MAX_OUTREACH_SUBJECT),
    body_text: z.string().trim().min(1).max(MAX_OUTREACH_BODY),
    linkedin_note: optionalText(MAX_LINKEDIN_NOTE),
  })
  .partial();

const ApproveInput = z.object({ content_hash: z.string().length(64) });

const notFound = { code: 'not_found', message: 'Outreach draft not found.' } as const;

/** Mounted at /api/outreach behind requireSession. Nothing here sends mail: approval queues the send job. */
export function createOutreachRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { handle, userId } = c.get('session');
    const applicationId = c.req.query('application_id');
    if (applicationId !== undefined && !isUuid(applicationId))
      return c.json({ code: 'validation', message: 'Invalid application id.' }, 400);
    const now = c.get('now')?.() ?? new Date();
    const [rows, sentToday] = await Promise.all([
      listOutreachDrafts(handle, userId, { applicationId }),
      countOutreachSentSince(handle, userId, startOfUtcDay(now)),
    ]);
    const body: OutreachListResponse = {
      drafts: rows.map(toDraftView),
      sent_today: sentToday,
      daily_cap: OUTREACH_DAILY_CAP,
    };
    return c.json(body);
  });

  // The user enters the contact; the worker drafts the email. The draft appears in the list when ready.
  app.post('/drafts', async (c) => {
    const { handle, userId, tenantId } = c.get('session');
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = CreateInput.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    const { application_id: applicationId, contact } = parsed.data;
    if (!isUuid(applicationId))
      return c.json({ code: 'validation', message: 'Invalid application id.' }, 400);
    const application = await getApplication(handle, applicationId);
    if (!application || application.userId !== userId)
      return c.json({ code: 'not_found', message: 'Application not found.' }, 404);
    const user = await getUserById(handle, userId);
    if (user.approvedProfileVersion === null)
      return c.json(
        { code: 'profile_not_approved', message: 'Approve your profile before drafting outreach.' },
        409,
      );
    const payload: DraftOutreachData = {
      tenantId,
      userId,
      applicationId,
      contact: {
        name: contact.name,
        title: contact.title,
        profile_url: contact.profile_url,
        email: contact.email,
      },
    };
    await handle.transaction(async (h) => {
      await insertPendingJob(
        h,
        {
          userId,
          kind: DRAFT_OUTREACH_JOB,
          payload: payload as unknown as Record<string, unknown>,
          dedupeKey: `${DRAFT_OUTREACH_JOB}:${applicationId}:${contact.email}`,
        },
        { rearm: true },
      );
      await activity.logActivity(h, {
        userId,
        applicationId,
        actor: 'user',
        action: 'outreach_draft_requested',
        detail: { contact_name: contact.name },
      });
    });
    return c.json({ queued: true }, 202);
  });

  app.patch('/:id', async (c) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json(notFound, 404);
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = EditInput.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    const e = parsed.data;
    const row = await editOutreachDraft(handle, userId, id, {
      toAddress: e.to_address,
      subject: e.subject,
      bodyText: e.body_text,
      linkedinNote: e.linkedin_note,
    });
    if (!row)
      return c.json({ code: 'not_editable', message: 'This draft can no longer be edited.' }, 409);
    await activity.logActivity(handle, {
      userId,
      applicationId: row.applicationId,
      actor: 'user',
      action: 'outreach_edited',
      detail: { draft_id: id },
    });
    return c.json({ draft: toDraftView(row) });
  });

  app.post('/:id/approve', async (c) => {
    const { handle, userId, tenantId } = c.get('session');
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json(notFound, 404);
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = ApproveInput.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    const now = c.get('now')?.() ?? new Date();
    const sentToday = await countOutreachSentSince(handle, userId, startOfUtcDay(now));
    if (sentToday >= OUTREACH_DAILY_CAP)
      return c.json(
        {
          code: 'daily_cap',
          message: `You have already sent ${OUTREACH_DAILY_CAP} outreach emails today. Approve it tomorrow.`,
        },
        409,
      );
    const result = await handle.transaction(async (h) => {
      const r = await approveOutreachDraft(h, userId, id, parsed.data.content_hash, now);
      if (r.status === 'approved') {
        const payload: SendOutreachData = { tenantId, userId, draftId: id };
        await insertPendingJob(h, {
          userId,
          kind: SEND_OUTREACH_JOB,
          payload: payload as unknown as Record<string, unknown>,
          dedupeKey: `${SEND_OUTREACH_JOB}:${id}`,
        });
        await activity.logActivity(h, {
          userId,
          applicationId: r.draft.applicationId,
          actor: 'user',
          action: 'outreach_approved',
          detail: { draft_id: id, to: r.draft.toAddress },
        });
      }
      return r;
    });
    switch (result.status) {
      case 'not_found':
        return c.json(notFound, 404);
      case 'wrong_state':
        return c.json(
          { code: 'wrong_state', message: `This draft is already ${result.state}.` },
          409,
        );
      case 'stale':
        return c.json(
          {
            code: 'stale',
            message: 'The draft changed since you opened it. Review it again.',
            draft: toDraftView(result.draft),
          },
          409,
        );
      case 'approved':
        return c.json({ draft: toDraftView(result.draft) });
    }
  });

  app.post('/:id/reject', async (c) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json(notFound, 404);
    const row = await rejectOutreachDraft(handle, userId, id);
    if (!row)
      return c.json(
        { code: 'not_rejectable', message: 'This draft can no longer be rejected.' },
        409,
      );
    await activity.logActivity(handle, {
      userId,
      applicationId: row.applicationId,
      actor: 'user',
      action: 'outreach_rejected',
      detail: { draft_id: id },
    });
    return c.json({ draft: toDraftView(row) });
  });

  return app;
}

export const outreachRoutes = createOutreachRoutes();
