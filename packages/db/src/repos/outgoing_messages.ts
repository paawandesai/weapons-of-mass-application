import { and, desc, eq, gt } from 'drizzle-orm';
import {
  redactConfirmTokens,
  type BlockedSend,
  type OutgoingReceipt,
  type OutgoingRecord,
  type OutgoingStore,
} from '@wma/shared';
import { logActivity } from '../activity';
import type { TenantHandle } from '../client';
import { outgoingMessages } from '../schema';

export type OutgoingMessageRow = typeof outgoingMessages.$inferSelect;
export type OutgoingKindValue = OutgoingMessageRow['kind'];

export interface OutgoingMessageInput {
  userId: string;
  kind: OutgoingKindValue;
  toAddress: string;
  subject: string;
  bodyText: string;
  applicationId?: string | null;
  bodyHtml?: string | null;
  gmailMessageId?: string | null;
  blocked?: boolean;
  blockedReason?: string | null;
  sentAt?: Date | null;
  state?: OutgoingMessageRow['state'];
  deliveryKey?: string | null;
}

export async function insertOutgoingMessage(
  handle: TenantHandle,
  input: OutgoingMessageInput,
): Promise<OutgoingMessageRow> {
  const rows = await handle.run((tx) =>
    tx
      .insert(outgoingMessages)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        applicationId: input.applicationId ?? null,
        kind: input.kind,
        toAddress: input.toAddress,
        subject: input.subject,
        // Confirmation links are capabilities: the audit copy never holds a live token.
        bodyText: redactConfirmTokens(input.bodyText),
        bodyHtml: redactConfirmTokens(input.bodyHtml ?? null),
        gmailMessageId: input.gmailMessageId ?? null,
        blocked: input.blocked ?? false,
        blockedReason: input.blockedReason ?? null,
        sentAt: input.sentAt ?? null,
        state: input.state ?? (input.blocked ? 'blocked' : 'sent'),
        deliveryKey: input.deliveryKey ?? null,
      })
      .returning(),
  );
  return rows[0]!;
}

const receiptOf = (r: OutgoingMessageRow): OutgoingReceipt => ({
  id: r.id,
  state: r.state,
  gmailMessageId: r.gmailMessageId,
  to: r.toAddress,
  subject: r.subject,
  createdAt: r.createdAt,
});

export async function getOutgoingMessageByKey(
  handle: TenantHandle,
  deliveryKey: string,
): Promise<OutgoingMessageRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(outgoingMessages)
      .where(
        and(
          eq(outgoingMessages.tenantId, handle.tenantId),
          eq(outgoingMessages.deliveryKey, deliveryKey),
        ),
      ),
  );
  return rows[0] ?? null;
}

export function listOutgoingMessagesForUser(
  handle: TenantHandle,
  userId: string,
  opts: { blockedOnly?: boolean; since?: Date } = {},
): Promise<OutgoingMessageRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(outgoingMessages)
      .where(
        and(
          eq(outgoingMessages.tenantId, handle.tenantId),
          eq(outgoingMessages.userId, userId),
          opts.blockedOnly ? eq(outgoingMessages.blocked, true) : undefined,
          opts.since ? gt(outgoingMessages.createdAt, opts.since) : undefined,
        ),
      )
      .orderBy(desc(outgoingMessages.createdAt), desc(outgoingMessages.id)),
  );
}

export function listOutgoingMessagesForApplication(
  handle: TenantHandle,
  applicationId: string,
): Promise<OutgoingMessageRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(outgoingMessages)
      .where(
        and(
          eq(outgoingMessages.tenantId, handle.tenantId),
          eq(outgoingMessages.applicationId, applicationId),
        ),
      )
      .orderBy(desc(outgoingMessages.createdAt), desc(outgoingMessages.id)),
  );
}

/** The persistence port `sendEmail` records every attempt through (rule 16). */
export function createOutgoingStore(handle: TenantHandle, userId: string): OutgoingStore {
  const toInput = (row: OutgoingRecord): OutgoingMessageInput => ({
    userId,
    kind: row.kind,
    toAddress: row.to,
    subject: row.subject,
    bodyText: row.bodyText,
    applicationId: row.applicationId,
    bodyHtml: row.bodyHtml,
    gmailMessageId: row.gmailMessageId,
    blocked: row.blocked,
    blockedReason: row.blockedReason,
    sentAt: row.sentAt,
  });
  return {
    async record(row) {
      const saved = await insertOutgoingMessage(handle, toInput(row));
      return { id: saved.id };
    },
    async begin(row) {
      const inserted = await handle.run((tx) =>
        tx
          .insert(outgoingMessages)
          .values({
            tenantId: handle.tenantId,
            userId,
            applicationId: row.applicationId,
            kind: row.kind,
            toAddress: row.to,
            subject: row.subject,
            bodyText: redactConfirmTokens(row.bodyText),
            bodyHtml: redactConfirmTokens(row.bodyHtml),
            state: 'pending',
            deliveryKey: row.deliveryKey,
          })
          .onConflictDoNothing()
          .returning({ id: outgoingMessages.id }),
      );
      if (inserted[0]) return { created: true as const, id: inserted[0].id };
      const existing = await getOutgoingMessageByKey(handle, row.deliveryKey);
      if (!existing) throw new Error(`delivery key ${row.deliveryKey} conflicted but no row found`);
      return { created: false as const, receipt: receiptOf(existing) };
    },
    async finalize(id, sent) {
      await handle.run((tx) =>
        tx
          .update(outgoingMessages)
          .set({ state: 'sent', gmailMessageId: sent.gmailMessageId, sentAt: sent.sentAt })
          .where(and(eq(outgoingMessages.tenantId, handle.tenantId), eq(outgoingMessages.id, id))),
      );
    },
    async findByKey(deliveryKey) {
      const row = await getOutgoingMessageByKey(handle, deliveryKey);
      return row ? receiptOf(row) : null;
    },
    async abandon(id) {
      await handle.run((tx) =>
        tx
          .delete(outgoingMessages)
          .where(
            and(
              eq(outgoingMessages.tenantId, handle.tenantId),
              eq(outgoingMessages.id, id),
              eq(outgoingMessages.state, 'pending'),
            ),
          ),
      );
    },
  };
}

/** `MailDeps.onBlocked` implementation: writes the `send_blocked` activity row. */
export function createBlockedLogger(
  handle: TenantHandle,
  userId: string,
): (blocked: BlockedSend) => Promise<void> {
  return async (blocked) => {
    await logActivity(handle, {
      userId,
      applicationId: blocked.email.applicationId ?? null,
      actor: 'agent',
      action: 'send_blocked',
      detail: {
        guard: blocked.guard,
        reason: blocked.reason,
        kind: blocked.email.kind ?? 'other',
        outgoing_id: blocked.outgoingId,
      },
    });
  };
}
