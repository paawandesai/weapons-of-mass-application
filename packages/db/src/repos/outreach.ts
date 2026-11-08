import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { outreachDrafts } from '../schema';

export type OutreachDraftRow = typeof outreachDrafts.$inferSelect;

/**
 * Identifies exactly what the user saw: recipient, subject and body. An approval is bound to this
 * hash, so an edit (or any change to those columns) voids it.
 */
export function outreachContentHash(c: {
  toAddress: string;
  subject: string;
  bodyText: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([c.toAddress.trim().toLowerCase(), c.subject, c.bodyText]))
    .digest('hex');
}

export interface OutreachDraftInput {
  userId: string;
  applicationId: string;
  contactName: string;
  contactTitle?: string | null;
  contactProfileUrl?: string | null;
  toAddress: string;
  subject: string;
  bodyText: string;
  linkedinNote?: string | null;
}

export async function createOutreachDraft(
  handle: TenantHandle,
  input: OutreachDraftInput,
): Promise<OutreachDraftRow> {
  const rows = await handle.run((tx) =>
    tx
      .insert(outreachDrafts)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        applicationId: input.applicationId,
        contactName: input.contactName,
        contactTitle: input.contactTitle ?? null,
        contactProfileUrl: input.contactProfileUrl ?? null,
        toAddress: input.toAddress.trim(),
        subject: input.subject,
        bodyText: input.bodyText,
        linkedinNote: input.linkedinNote ?? null,
      })
      .returning(),
  );
  return rows[0]!;
}

const owned = (handle: TenantHandle, userId: string, id: string) =>
  and(
    eq(outreachDrafts.tenantId, handle.tenantId),
    eq(outreachDrafts.userId, userId),
    eq(outreachDrafts.id, id),
  );

export async function getOutreachDraft(
  handle: TenantHandle,
  userId: string,
  id: string,
): Promise<OutreachDraftRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(outreachDrafts)
      .where(owned(handle, userId, id)),
  );
  return rows[0] ?? null;
}

/** The send job knows only the id (it carries the user in its payload, which it checks here). */
export async function listOutreachDrafts(
  handle: TenantHandle,
  userId: string,
  opts: { applicationId?: string } = {},
): Promise<OutreachDraftRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.tenantId, handle.tenantId),
          eq(outreachDrafts.userId, userId),
          opts.applicationId ? eq(outreachDrafts.applicationId, opts.applicationId) : undefined,
        ),
      )
      .orderBy(desc(outreachDrafts.createdAt)),
  );
}

export interface OutreachEdit {
  toAddress?: string;
  subject?: string;
  bodyText?: string;
  linkedinNote?: string | null;
  contactName?: string;
  contactTitle?: string | null;
  contactProfileUrl?: string | null;
}

/**
 * Edits a draft that is not yet sending. Any edit returns an approved draft to `draft` and clears
 * the approval, so the user must approve the new text. Returns null when the draft is missing or
 * already sending, sent, rejected or failed.
 */
export async function editOutreachDraft(
  handle: TenantHandle,
  userId: string,
  id: string,
  edit: OutreachEdit,
): Promise<OutreachDraftRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(outreachDrafts)
      .set({
        ...(edit.toAddress !== undefined ? { toAddress: edit.toAddress.trim() } : {}),
        ...(edit.subject !== undefined ? { subject: edit.subject } : {}),
        ...(edit.bodyText !== undefined ? { bodyText: edit.bodyText } : {}),
        ...(edit.linkedinNote !== undefined ? { linkedinNote: edit.linkedinNote } : {}),
        ...(edit.contactName !== undefined ? { contactName: edit.contactName } : {}),
        ...(edit.contactTitle !== undefined ? { contactTitle: edit.contactTitle } : {}),
        ...(edit.contactProfileUrl !== undefined
          ? { contactProfileUrl: edit.contactProfileUrl }
          : {}),
        state: 'draft',
        approvedHash: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(and(owned(handle, userId, id), inArray(outreachDrafts.state, ['draft', 'approved'])))
      .returning(),
  );
  return rows[0] ?? null;
}

export type ApproveResult =
  | { status: 'approved'; draft: OutreachDraftRow }
  | { status: 'not_found' }
  /** The draft is not in `draft` (already approved, sending, sent, rejected or failed). */
  | { status: 'wrong_state'; state: OutreachDraftRow['state'] }
  /** The content changed since the user looked: they must review it again. */
  | { status: 'stale'; draft: OutreachDraftRow };

/** Approves exactly the content the user saw (`seenHash`). Edits since then make it `stale`. */
export async function approveOutreachDraft(
  handle: TenantHandle,
  userId: string,
  id: string,
  seenHash: string,
  now: Date = new Date(),
): Promise<ApproveResult> {
  const row = await getOutreachDraft(handle, userId, id);
  if (!row) return { status: 'not_found' };
  if (row.state !== 'draft') return { status: 'wrong_state', state: row.state };
  const hash = outreachContentHash(row);
  if (hash !== seenHash) return { status: 'stale', draft: row };
  const rows = await handle.run((tx) =>
    tx
      .update(outreachDrafts)
      .set({ state: 'approved', approvedHash: hash, approvedAt: now, updatedAt: now })
      .where(
        and(
          owned(handle, userId, id),
          eq(outreachDrafts.state, 'draft'),
          // The content must still be the content that was hashed.
          eq(outreachDrafts.toAddress, row.toAddress),
          eq(outreachDrafts.subject, row.subject),
          eq(outreachDrafts.bodyText, row.bodyText),
        ),
      )
      .returning(),
  );
  if (!rows[0])
    return { status: 'stale', draft: (await getOutreachDraft(handle, userId, id)) ?? row };
  return { status: 'approved', draft: rows[0] };
}

/** Draft or approved -> rejected. Returns null when it cannot be rejected any more. */
export async function rejectOutreachDraft(
  handle: TenantHandle,
  userId: string,
  id: string,
): Promise<OutreachDraftRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(outreachDrafts)
      .set({ state: 'rejected', approvedHash: null, approvedAt: null, updatedAt: new Date() })
      .where(and(owned(handle, userId, id), inArray(outreachDrafts.state, ['draft', 'approved'])))
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * The send guard. Moves an approved draft to `sending` and returns it only when its stored approval
 * still matches its current recipient, subject and body. A draft already `sending` is returned too
 * (a retry after a crash; the delivery key keeps the send single). Anything else returns null:
 * never approved, edited since, rejected, sent.
 */
export async function claimOutreachForSend(
  handle: TenantHandle,
  userId: string,
  id: string,
): Promise<OutreachDraftRow | null> {
  return handle.transaction(async (h) => {
    const rows = await h.run((tx) =>
      tx
        .select()
        .from(outreachDrafts)
        .where(owned(h, userId, id))
        .for('update'),
    );
    const row = rows[0];
    if (!row || (row.state !== 'approved' && row.state !== 'sending')) return null;
    if (!row.approvedHash || row.approvedHash !== outreachContentHash(row)) return null;
    if (row.state === 'sending') return row;
    const updated = await h.run((tx) =>
      tx
        .update(outreachDrafts)
        .set({ state: 'sending', updatedAt: new Date() })
        .where(and(owned(h, userId, id), eq(outreachDrafts.state, 'approved')))
        .returning(),
    );
    return updated[0] ?? null;
  });
}

export async function markOutreachSent(
  handle: TenantHandle,
  userId: string,
  id: string,
  outgoingId: string,
  sentAt: Date,
): Promise<void> {
  await handle.run((tx) =>
    tx
      .update(outreachDrafts)
      .set({ state: 'sent', outgoingId, sentAt, updatedAt: sentAt })
      .where(owned(handle, userId, id)),
  );
}

export async function markOutreachFailed(
  handle: TenantHandle,
  userId: string,
  id: string,
  reason: string,
): Promise<void> {
  await handle.run((tx) =>
    tx
      .update(outreachDrafts)
      .set({ state: 'failed', failureReason: reason.slice(0, 500), updatedAt: new Date() })
      .where(and(owned(handle, userId, id), eq(outreachDrafts.state, 'sending'))),
  );
}

/** Emails sent or in flight since `since`: what the daily cap counts. */
export async function countOutreachSentSince(
  handle: TenantHandle,
  userId: string,
  since: Date,
): Promise<number> {
  const rows = await handle.run((tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.tenantId, handle.tenantId),
          eq(outreachDrafts.userId, userId),
          inArray(outreachDrafts.state, ['sending', 'sent']),
          gte(outreachDrafts.updatedAt, since),
        ),
      ),
  );
  return rows[0]?.n ?? 0;
}
