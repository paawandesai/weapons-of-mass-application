import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, ilike, lte, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { demoMailboxMessages } from '../schema';

export type DemoMailboxMessageRow = typeof demoMailboxMessages.$inferSelect;

export interface DemoMessageInput {
  userId: string;
  /** Defaults to a new thread. */
  threadId?: string;
  /** Defaults to a generated `demo-msg-<uuid>`; inserting an existing id returns the stored row. */
  gmailMessageId?: string;
  fromAddress: string;
  fromName?: string | null;
  toAddress: string;
  subject: string;
  bodyText: string;
  headers?: Record<string, string>;
  /** Defaults to ['INBOX']. Sent mail carries ['SENT']. */
  labelIds?: string[];
  /** Defaults to now. */
  internalDate?: Date;
}

/**
 * Appends a message to the tenant's demo mailbox. The history id is allocated in the same
 * transaction (strictly increasing per tenant), so every insert advances it. Idempotent on
 * `gmailMessageId`: a repeat returns the stored row and advances nothing.
 */
export function insertDemoMessage(
  handle: TenantHandle,
  input: DemoMessageInput,
): Promise<DemoMailboxMessageRow> {
  return handle.transaction(async (h) => {
    const historyId = await h.run(async (tx) => {
      const r = await tx.execute(sql`select wma_demo_next_history_id(${h.tenantId}::uuid) as id`);
      return Number((r.rows[0] as { id: string | number }).id);
    });
    const gmailMessageId = input.gmailMessageId ?? `demo-msg-${randomUUID()}`;
    const existing = await getDemoMessage(h, gmailMessageId);
    if (existing) return existing;
    const rows = await h.run((tx) =>
      tx
        .insert(demoMailboxMessages)
        .values({
          tenantId: h.tenantId,
          userId: input.userId,
          threadId: input.threadId ?? `demo-thread-${randomUUID()}`,
          gmailMessageId,
          historyId,
          fromAddress: input.fromAddress,
          fromName: input.fromName ?? null,
          toAddress: input.toAddress,
          subject: input.subject,
          bodyText: input.bodyText,
          headers: input.headers ?? {},
          labelIds: input.labelIds ?? ['INBOX'],
          internalDate: input.internalDate ?? new Date(),
        })
        .returning(),
    );
    return rows[0]!;
  });
}

export async function getDemoMessage(
  handle: TenantHandle,
  gmailMessageId: string,
): Promise<DemoMailboxMessageRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(demoMailboxMessages)
      .where(
        and(
          eq(demoMailboxMessages.tenantId, handle.tenantId),
          eq(demoMailboxMessages.gmailMessageId, gmailMessageId),
        ),
      ),
  );
  return rows[0] ?? null;
}

/** A thread's messages, oldest first. */
export function listDemoThread(
  handle: TenantHandle,
  threadId: string,
): Promise<DemoMailboxMessageRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(demoMailboxMessages)
      .where(
        and(
          eq(demoMailboxMessages.tenantId, handle.tenantId),
          eq(demoMailboxMessages.threadId, threadId),
        ),
      )
      .orderBy(asc(demoMailboxMessages.internalDate), asc(demoMailboxMessages.historyId)),
  );
}

/** The mailbox's newest history id for the user, or 0 for an empty mailbox. */
export async function currentDemoHistoryId(handle: TenantHandle, userId: string): Promise<number> {
  const rows = await handle.run((tx) =>
    tx
      .select({ id: demoMailboxMessages.historyId })
      .from(demoMailboxMessages)
      .where(
        and(
          eq(demoMailboxMessages.tenantId, handle.tenantId),
          eq(demoMailboxMessages.userId, userId),
        ),
      )
      .orderBy(desc(demoMailboxMessages.historyId))
      .limit(1),
  );
  return rows[0]?.id ?? 0;
}

/**
 * Messages carrying `label` added after `historyId` (and, when given, up to and including
 * `through`), in history order.
 */
export function listDemoMessagesAfterHistory(
  handle: TenantHandle,
  userId: string,
  historyId: number,
  label = 'INBOX',
  through?: number,
): Promise<DemoMailboxMessageRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(demoMailboxMessages)
      .where(
        and(
          eq(demoMailboxMessages.tenantId, handle.tenantId),
          eq(demoMailboxMessages.userId, userId),
          gt(demoMailboxMessages.historyId, historyId),
          ...(through === undefined ? [] : [lte(demoMailboxMessages.historyId, through)]),
          sql`${label} = any(${demoMailboxMessages.labelIds})`,
        ),
      )
      .orderBy(asc(demoMailboxMessages.historyId)),
  );
}

/** Messages carrying `label` received at or after `after`. */
export function listDemoMessagesSince(
  handle: TenantHandle,
  userId: string,
  after: Date,
  label = 'INBOX',
): Promise<DemoMailboxMessageRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(demoMailboxMessages)
      .where(
        and(
          eq(demoMailboxMessages.tenantId, handle.tenantId),
          eq(demoMailboxMessages.userId, userId),
          gte(demoMailboxMessages.internalDate, after),
          sql`${label} = any(${demoMailboxMessages.labelIds})`,
        ),
      )
      .orderBy(asc(demoMailboxMessages.historyId)),
  );
}

/** A SENT message to this address with exactly this subject, at or after `after` (newest first). */
export async function findDemoSent(
  handle: TenantHandle,
  userId: string,
  query: { to: string; subject: string; after: Date },
): Promise<DemoMailboxMessageRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(demoMailboxMessages)
      .where(
        and(
          eq(demoMailboxMessages.tenantId, handle.tenantId),
          eq(demoMailboxMessages.userId, userId),
          sql`'SENT' = any(${demoMailboxMessages.labelIds})`,
          ilike(demoMailboxMessages.toAddress, `%${query.to.replace(/[\\%_]/g, '\\$&')}%`),
          eq(demoMailboxMessages.subject, query.subject),
          gte(demoMailboxMessages.internalDate, query.after),
        ),
      )
      .orderBy(desc(demoMailboxMessages.historyId))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** Every message of the user's mailbox, oldest first (diagnostics and the simulated recruiter). */
export function listDemoMessages(
  handle: TenantHandle,
  userId: string,
): Promise<DemoMailboxMessageRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(demoMailboxMessages)
      .where(
        and(
          eq(demoMailboxMessages.tenantId, handle.tenantId),
          eq(demoMailboxMessages.userId, userId),
        ),
      )
      .orderBy(asc(demoMailboxMessages.historyId)),
  );
}
