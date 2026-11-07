import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { interviewSlots, interviews } from '../schema';

export type InterviewSlotRow = typeof interviewSlots.$inferSelect;

export interface InterviewSlotInput {
  interviewId: string;
  startsAt: Date;
  endsAt: Date;
  tzHint?: string | null;
  /** sha256 of the token; the token itself is never stored. */
  tokenHash: string;
  /** Seconds from the database clock until the token expires (default 7 days). */
  ttlSeconds?: number;
}

export const SLOT_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

/** Expiry is computed on the database clock so it matches the check in `confirmSlotByTokenHash`. */
export async function insertInterviewSlot(
  handle: TenantHandle,
  input: InterviewSlotInput,
): Promise<InterviewSlotRow> {
  const ttl = input.ttlSeconds ?? SLOT_TOKEN_TTL_SECONDS;
  const rows = await handle.run((tx) =>
    tx
      .insert(interviewSlots)
      .values({
        tenantId: handle.tenantId,
        interviewId: input.interviewId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        tzHint: input.tzHint ?? null,
        tokenHash: input.tokenHash,
        expiresAt: sql`now() + make_interval(secs => ${ttl})`,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function getInterviewSlot(
  handle: TenantHandle,
  id: string,
): Promise<InterviewSlotRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(interviewSlots)
      .where(and(eq(interviewSlots.tenantId, handle.tenantId), eq(interviewSlots.id, id))),
  );
  return rows[0] ?? null;
}

export function listSlotsForInterview(
  handle: TenantHandle,
  interviewId: string,
): Promise<InterviewSlotRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(interviewSlots)
      .where(
        and(
          eq(interviewSlots.tenantId, handle.tenantId),
          eq(interviewSlots.interviewId, interviewId),
        ),
      )
      .orderBy(asc(interviewSlots.startsAt), asc(interviewSlots.id)),
  );
}

export interface SlotView extends InterviewSlotRow {
  /** True when the token can still be used: not invalidated, not confirmed, not expired and not started (database clock), interview unconfirmed. */
  open: boolean;
}

/** Read-only lookup for the GET page; it never confirms. */
export async function getSlotByTokenHash(
  handle: TenantHandle,
  tokenHash: string,
): Promise<SlotView | null> {
  const rows = await handle.run((tx) =>
    tx
      .select({
        slot: interviewSlots,
        open: sql<boolean>`(${interviewSlots.invalidatedAt} is null
          and ${interviewSlots.confirmedAt} is null
          and ${interviewSlots.expiresAt} > now()
          and ${interviewSlots.startsAt} > now()
          and ${interviews.confirmedSlotId} is null)`,
      })
      .from(interviewSlots)
      .innerJoin(
        interviews,
        and(
          eq(interviews.tenantId, interviewSlots.tenantId),
          eq(interviews.id, interviewSlots.interviewId),
        ),
      )
      .where(
        and(eq(interviewSlots.tenantId, handle.tenantId), eq(interviewSlots.tokenHash, tokenHash)),
      ),
  );
  const r = rows[0];
  return r ? { ...r.slot, open: r.open } : null;
}

export type ConfirmSlotResult =
  | {
      ok: true;
      interviewId: string;
      slotId: string;
      startsAt: Date;
      endsAt: Date;
      /** The interview's confirmed generation after this confirmation. */
      generation: number;
    }
  | { ok: false; reason: 'no_longer_open' };

/**
 * Confirms a slot by its token hash in ONE transaction: the interview row is locked, the token
 * must be unused, not invalidated, unexpired and not yet started on the database clock and the interview must have no
 * confirmed slot. On success the slot is confirmed, the interview records the slot and its times,
 * and sibling tokens are invalidated. Any other case writes nothing.
 */
export function confirmSlotByTokenHash(
  handle: TenantHandle,
  tokenHash: string,
): Promise<ConfirmSlotResult> {
  return handle.run(async (tx) => {
    const found = await tx
      .select({ interviewId: interviewSlots.interviewId })
      .from(interviewSlots)
      .where(
        and(eq(interviewSlots.tenantId, handle.tenantId), eq(interviewSlots.tokenHash, tokenHash)),
      );
    const interviewId = found[0]?.interviewId;
    if (!interviewId) return { ok: false, reason: 'no_longer_open' } as const;

    // Serialize competing confirmations on the same interview.
    const locked = await tx
      .select({ confirmedSlotId: interviews.confirmedSlotId })
      .from(interviews)
      .where(and(eq(interviews.tenantId, handle.tenantId), eq(interviews.id, interviewId)))
      .for('update');
    if (!locked[0] || locked[0].confirmedSlotId !== null) {
      return { ok: false, reason: 'no_longer_open' } as const;
    }

    const confirmed = await tx
      .update(interviewSlots)
      .set({ confirmedAt: sql`now()` })
      .where(
        and(
          eq(interviewSlots.tenantId, handle.tenantId),
          eq(interviewSlots.tokenHash, tokenHash),
          isNull(interviewSlots.invalidatedAt),
          isNull(interviewSlots.confirmedAt),
          sql`${interviewSlots.expiresAt} > now()`,
          sql`${interviewSlots.startsAt} > now()`,
        ),
      )
      .returning();
    const slot = confirmed[0];
    if (!slot) return { ok: false, reason: 'no_longer_open' } as const;

    const bumped = await tx
      .update(interviews)
      .set({
        confirmedSlotId: slot.id,
        confirmedAt: sql`now()`,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        confirmedGeneration: sql`${interviews.confirmedGeneration} + 1`,
      })
      .where(and(eq(interviews.tenantId, handle.tenantId), eq(interviews.id, interviewId)))
      .returning({ generation: interviews.confirmedGeneration });
    await tx
      .update(interviewSlots)
      .set({ invalidatedAt: sql`now()` })
      .where(
        and(
          eq(interviewSlots.tenantId, handle.tenantId),
          eq(interviewSlots.interviewId, interviewId),
          ne(interviewSlots.id, slot.id),
          isNull(interviewSlots.invalidatedAt),
        ),
      );
    return {
      ok: true,
      interviewId,
      slotId: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      generation: bumped[0]!.generation,
    } as const;
  });
}

/** Invalidates every still-open slot of an interview (for example when new times replace them). */
export async function invalidateOpenSlots(
  handle: TenantHandle,
  interviewId: string,
): Promise<number> {
  const rows = await handle.run((tx) =>
    tx
      .update(interviewSlots)
      .set({ invalidatedAt: sql`now()` })
      .where(
        and(
          eq(interviewSlots.tenantId, handle.tenantId),
          eq(interviewSlots.interviewId, interviewId),
          isNull(interviewSlots.invalidatedAt),
          isNull(interviewSlots.confirmedAt),
        ),
      )
      .returning({ id: interviewSlots.id }),
  );
  return rows.length;
}
