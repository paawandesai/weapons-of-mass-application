import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { captchaRequests } from '../schema';
import {
  hasOpenHumanCaptcha,
  updateCaptchaRequest,
  type CaptchaRequestRow,
} from './captcha_requests';

/**
 * Takes the user's single human-stage slot for a request. The check and the write are one
 * transaction serialized per user, so two concurrent requests cannot both succeed.
 */
export async function reserveHumanStage(
  handle: TenantHandle,
  input: {
    requestId: string;
    userId: string;
    tokenHash: string;
    imageRef: string;
    expiresAt: Date;
    now: Date;
  },
): Promise<'reserved' | 'busy'> {
  return handle.transaction(async (h) => {
    await h.run((tx) =>
      tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`captcha-human:${input.userId}`}, 0))`,
      ),
    );
    if (await hasOpenHumanCaptcha(h, input.userId, input.now)) return 'busy' as const;
    await updateCaptchaRequest(h, input.requestId, {
      stage: 'human',
      tokenHash: input.tokenHash,
      imageRef: input.imageRef,
      expiresAt: input.expiresAt,
    });
    return 'reserved' as const;
  });
}

/**
 * Writes the visitor's answer if, and only if, the request behind this token hash is still open:
 * unanswered, unresolved, not expired and inside its window. Single statement that reads the
 * database clock at the write, so a slow request body or a skewed app clock cannot extend the
 * window, and a reused or racing token writes at most once.
 */
export async function submitHumanAnswer(
  handle: TenantHandle,
  tokenHash: string,
  answer: string,
): Promise<CaptchaRequestRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(captchaRequests)
      .set({ humanAnswer: answer })
      .where(
        and(
          eq(captchaRequests.tenantId, handle.tenantId),
          eq(captchaRequests.tokenHash, tokenHash),
          eq(captchaRequests.stage, 'human'),
          isNull(captchaRequests.humanAnswer),
          isNull(captchaRequests.resolvedAt),
          isNull(captchaRequests.expiredAt),
          sql`${captchaRequests.expiresAt} > now()`,
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * The request that currently carries this token hash and can still take an answer (database
 * clock), in one tenant-scoped query: a token the worker has since replaced finds nothing.
 */
export async function getOpenCaptchaByTokenHash(
  handle: TenantHandle,
  tokenHash: string,
): Promise<CaptchaRequestRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(captchaRequests)
      .where(
        and(
          eq(captchaRequests.tenantId, handle.tenantId),
          eq(captchaRequests.tokenHash, tokenHash),
          eq(captchaRequests.stage, 'human'),
          isNull(captchaRequests.humanAnswer),
          isNull(captchaRequests.resolvedAt),
          isNull(captchaRequests.expiredAt),
          sql`${captchaRequests.expiresAt} > now()`,
        ),
      ),
  );
  return rows[0] ?? null;
}

/** True when a loaded row can still take an answer (same conditions, caller-supplied clock). */
export function isCaptchaOpen(row: CaptchaRequestRow, now: Date): boolean {
  return (
    row.stage === 'human' &&
    row.humanAnswer === null &&
    row.resolvedAt === null &&
    row.expiredAt === null &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() > now.getTime()
  );
}

/**
 * Extends the window of the request this worker reserved, once the challenge has been sent. Runs
 * under the same per-user lock as reserveHumanStage and verifies ownership: the row must still
 * hold the worker's token, be unexpired on the database clock, and be the user's only open human
 * request. Returns false when the reservation was lost, in which case nothing is written.
 */
export async function extendHumanReservation(
  handle: TenantHandle,
  input: { requestId: string; userId: string; tokenHash: string; windowMs: number },
): Promise<Date | null> {
  return handle.transaction(async (h) => {
    await h.run((tx) =>
      tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`captcha-human:${input.userId}`}, 0))`,
      ),
    );
    const rows = await h.run((tx) =>
      tx
        .update(captchaRequests)
        .set({
          expiresAt: sql`now() + (${input.windowMs}::double precision * interval '1 millisecond')`,
        })
        .where(
          and(
            eq(captchaRequests.tenantId, h.tenantId),
            eq(captchaRequests.id, input.requestId),
            eq(captchaRequests.userId, input.userId),
            eq(captchaRequests.tokenHash, input.tokenHash),
            eq(captchaRequests.stage, 'human'),
            isNull(captchaRequests.resolvedAt),
            isNull(captchaRequests.expiredAt),
            sql`${captchaRequests.expiresAt} > now()`,
            sql`not exists (
              select 1 from captcha_requests o
              where o.tenant_id = ${captchaRequests.tenantId} and o.user_id = ${captchaRequests.userId}
                and o.id <> ${captchaRequests.id} and o.stage = 'human'
                and o.resolved_at is null and o.expired_at is null and o.expires_at > now())`,
          ),
        )
        .returning({ expiresAt: captchaRequests.expiresAt }),
    );
    return rows[0]?.expiresAt ?? null;
  });
}

/** Replaces the token and clears the answer so the next reply is a fresh, single-use one. */
export async function reissueHumanToken(
  handle: TenantHandle,
  requestId: string,
  input: { tokenHash: string; imageRef: string },
): Promise<CaptchaRequestRow | null> {
  return updateCaptchaRequest(handle, requestId, {
    tokenHash: input.tokenHash,
    imageRef: input.imageRef,
    humanAnswer: null,
  });
}
