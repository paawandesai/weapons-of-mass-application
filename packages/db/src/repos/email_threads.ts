import { and, desc, eq, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { emailThreads } from '../schema';

export type EmailThreadRow = typeof emailThreads.$inferSelect;
export type ThreadKind = EmailThreadRow['kind'];

export interface EmailThreadInput {
  userId: string;
  gmailThreadId: string;
  kind: ThreadKind;
  applicationId?: string | null;
  compensationFlag?: boolean;
  bookingLink?: string | null;
  /** Subject of the thread's first message; kept once stored. */
  subject?: string | null;
  promptVersion?: string | null;
  lastMessageAt?: Date;
}

/**
 * One row per (tenant, Gmail thread). A second call for the same thread updates the row
 * chronologically: kind, booking link and prompt version change only when the incoming message is
 * at least as new as the stored last message (Gmail lists newest first, so an older message
 * processed later must not undo a newer classification); last_message_at only moves forward; and the
 * compensation flag is sticky for the thread (once set it stays set). The existing application
 * link is kept unless a new one is given.
 */
export async function upsertEmailThread(
  handle: TenantHandle,
  input: EmailThreadInput,
): Promise<EmailThreadRow> {
  const t = emailThreads;
  // `excluded.last_message_at` is now() when the caller gave none: such a call counts as newest.
  const newer = sql`excluded.last_message_at >= ${t.lastMessageAt}`;
  const set = {
    kind: sql`CASE WHEN ${newer} THEN excluded.kind ELSE ${t.kind} END`,
    lastMessageAt: sql`GREATEST(${t.lastMessageAt}, excluded.last_message_at)`,
    compensationFlag: sql`(${t.compensationFlag} OR excluded.compensation_flag)`,
    subject: sql`COALESCE(${t.subject}, excluded.subject)`,
    ...(input.applicationId !== undefined ? { applicationId: input.applicationId } : {}),
    ...(input.bookingLink !== undefined
      ? {
          bookingLink: sql`CASE WHEN ${newer} THEN excluded.booking_link ELSE ${t.bookingLink} END`,
        }
      : {}),
    ...(input.promptVersion !== undefined
      ? {
          promptVersion: sql`CASE WHEN ${newer} THEN excluded.prompt_version ELSE ${t.promptVersion} END`,
        }
      : {}),
  };
  const rows = await handle.run((tx) =>
    tx
      .insert(emailThreads)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        gmailThreadId: input.gmailThreadId,
        kind: input.kind,
        applicationId: input.applicationId ?? null,
        compensationFlag: input.compensationFlag ?? false,
        bookingLink: input.bookingLink ?? null,
        subject: input.subject ?? null,
        promptVersion: input.promptVersion ?? null,
        ...(input.lastMessageAt ? { lastMessageAt: input.lastMessageAt } : {}),
      })
      .onConflictDoUpdate({
        target: [emailThreads.tenantId, emailThreads.gmailThreadId],
        set,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function getEmailThread(
  handle: TenantHandle,
  id: string,
): Promise<EmailThreadRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(emailThreads)
      .where(and(eq(emailThreads.tenantId, handle.tenantId), eq(emailThreads.id, id))),
  );
  return rows[0] ?? null;
}

export async function getEmailThreadByGmailId(
  handle: TenantHandle,
  gmailThreadId: string,
): Promise<EmailThreadRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(emailThreads)
      .where(
        and(
          eq(emailThreads.tenantId, handle.tenantId),
          eq(emailThreads.gmailThreadId, gmailThreadId),
        ),
      ),
  );
  return rows[0] ?? null;
}

/** Latest message first. */
export function listEmailThreadsForApplication(
  handle: TenantHandle,
  applicationId: string,
): Promise<EmailThreadRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(emailThreads)
      .where(
        and(
          eq(emailThreads.tenantId, handle.tenantId),
          eq(emailThreads.applicationId, applicationId),
        ),
      )
      .orderBy(desc(emailThreads.lastMessageAt), desc(emailThreads.id)),
  );
}

export function listEmailThreadsForUser(
  handle: TenantHandle,
  userId: string,
): Promise<EmailThreadRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(emailThreads)
      .where(and(eq(emailThreads.tenantId, handle.tenantId), eq(emailThreads.userId, userId)))
      .orderBy(desc(emailThreads.lastMessageAt), desc(emailThreads.id)),
  );
}
