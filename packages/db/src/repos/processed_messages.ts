import { and, eq, inArray } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { processedMessages } from '../schema';

export type ProcessedMessageRow = typeof processedMessages.$inferSelect;
export type ProcessedOutcome = ProcessedMessageRow['outcome'];

export interface ProcessedMessageInput {
  userId: string;
  gmailMessageId: string;
  outcome: ProcessedOutcome;
  threadId?: string | null;
}

/**
 * Records a message as processed. Returns true when this call recorded it, false when the
 * message was already recorded (the existing row is kept), so a caller can skip a repeat.
 */
export async function markMessageProcessed(
  handle: TenantHandle,
  input: ProcessedMessageInput,
): Promise<boolean> {
  const rows = await handle.run((tx) =>
    tx
      .insert(processedMessages)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        gmailMessageId: input.gmailMessageId,
        outcome: input.outcome,
        threadId: input.threadId ?? null,
      })
      .onConflictDoNothing({
        target: [processedMessages.tenantId, processedMessages.gmailMessageId],
      })
      .returning({ id: processedMessages.gmailMessageId }),
  );
  return rows.length > 0;
}

export async function isMessageProcessed(
  handle: TenantHandle,
  gmailMessageId: string,
): Promise<boolean> {
  const rows = await handle.run((tx) =>
    tx
      .select({ id: processedMessages.gmailMessageId })
      .from(processedMessages)
      .where(
        and(
          eq(processedMessages.tenantId, handle.tenantId),
          eq(processedMessages.gmailMessageId, gmailMessageId),
        ),
      ),
  );
  return rows.length > 0;
}

/** Which of these Gmail message ids are already recorded. */
export async function listProcessedMessageIds(
  handle: TenantHandle,
  gmailMessageIds: string[],
): Promise<Set<string>> {
  if (gmailMessageIds.length === 0) return new Set();
  const rows = await handle.run((tx) =>
    tx
      .select({ id: processedMessages.gmailMessageId })
      .from(processedMessages)
      .where(
        and(
          eq(processedMessages.tenantId, handle.tenantId),
          inArray(processedMessages.gmailMessageId, gmailMessageIds),
        ),
      ),
  );
  return new Set(rows.map((r) => r.id));
}
