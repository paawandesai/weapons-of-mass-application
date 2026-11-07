import { and, desc, eq } from 'drizzle-orm';
import { logActivity } from '../activity';
import type { TenantHandle } from '../client';
import { applications, stageOverrides } from '../schema';
import type { ApplicationStatus } from './applications';

export type StageOverrideRow = typeof stageOverrides.$inferSelect;

export interface ChangeStageInput {
  userId: string;
  applicationId: string;
  /** The status the client saw; the move applies only while the card still has it. */
  from: ApplicationStatus;
  to: ApplicationStatus;
}

/**
 * `ok: true`: the move was applied (or `from === to` and the card already has that status, which
 * writes nothing). `ok: false`: nothing was written; `current` is the stored status, or null when
 * the application does not exist for this user (the caller answers 404).
 */
export type ChangeStageResult = { ok: true } | { ok: false; current: ApplicationStatus | null };

/**
 * A user's board move (design rule 2), in one transaction: the status update conditioned on the
 * status the client saw, a `stage_overrides` row and a user-actor `stage_changed` activity entry.
 * A mismatch writes nothing. Moving to closed records `closed_reason = 'user'`; moving out of
 * closed clears it.
 */
export function changeStageByUser(
  handle: TenantHandle,
  input: ChangeStageInput,
): Promise<ChangeStageResult> {
  return handle.transaction(async (h) => {
    const mine = and(
      eq(applications.tenantId, h.tenantId),
      eq(applications.userId, input.userId),
      eq(applications.id, input.applicationId),
    );
    if (input.from === input.to) {
      const rows = await h.run((tx) =>
        tx.select({ status: applications.status }).from(applications).where(mine),
      );
      const status = rows[0]?.status ?? null;
      return status === input.from ? { ok: true } : { ok: false, current: status };
    }
    const updated = await h.run((tx) =>
      tx
        .update(applications)
        .set({
          status: input.to,
          ...(input.to === 'closed'
            ? { closedReason: 'user' }
            : input.from === 'closed'
              ? { closedReason: null }
              : {}),
          lastActivityAt: new Date(),
        })
        .where(and(mine, eq(applications.status, input.from)))
        .returning({ id: applications.id }),
    );
    if (updated.length === 0) {
      const rows = await h.run((tx) =>
        tx.select({ status: applications.status }).from(applications).where(mine),
      );
      return { ok: false, current: rows[0]?.status ?? null };
    }
    await h.run((tx) =>
      tx.insert(stageOverrides).values({
        tenantId: h.tenantId,
        userId: input.userId,
        applicationId: input.applicationId,
        fromStatus: input.from,
        toStatus: input.to,
      }),
    );
    await logActivity(h, {
      userId: input.userId,
      applicationId: input.applicationId,
      actor: 'user',
      action: 'stage_changed',
      detail: { from: input.from, to: input.to },
    });
    return { ok: true };
  });
}

export function listStageOverrides(
  handle: TenantHandle,
  applicationId: string,
): Promise<StageOverrideRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(stageOverrides)
      .where(
        and(
          eq(stageOverrides.tenantId, handle.tenantId),
          eq(stageOverrides.applicationId, applicationId),
        ),
      )
      .orderBy(desc(stageOverrides.at), desc(stageOverrides.id)),
  );
}
