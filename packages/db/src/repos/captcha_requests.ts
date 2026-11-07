import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { TenantHandle } from '../client';
import { captchaRequests } from '../schema';

export type CaptchaRequestRow = typeof captchaRequests.$inferSelect;
export type CaptchaStage = CaptchaRequestRow['stage'];
export type CaptchaPatch = Partial<
  Pick<
    CaptchaRequestRow,
    | 'stage'
    | 'attempts'
    | 'imageRef'
    | 'tokenHash'
    | 'expiresAt'
    | 'humanAnswer'
    | 'resolvedBy'
    | 'resolvedAt'
    | 'expiredAt'
  >
>;

export interface CaptchaRequestInput {
  userId: string;
  applicationId: string;
  imageRef?: string | null;
  stage?: CaptchaStage;
}

export async function insertCaptchaRequest(
  handle: TenantHandle,
  input: CaptchaRequestInput,
): Promise<CaptchaRequestRow> {
  const rows = await handle.run((tx) =>
    tx
      .insert(captchaRequests)
      .values({
        tenantId: handle.tenantId,
        userId: input.userId,
        applicationId: input.applicationId,
        imageRef: input.imageRef ?? null,
        stage: input.stage ?? 'agent1',
      })
      .returning(),
  );
  return rows[0]!;
}

export async function getCaptchaRequest(
  handle: TenantHandle,
  id: string,
): Promise<CaptchaRequestRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .select()
      .from(captchaRequests)
      .where(and(eq(captchaRequests.tenantId, handle.tenantId), eq(captchaRequests.id, id))),
  );
  return rows[0] ?? null;
}

/** Latest first. */
export function listCaptchaRequestsForApplication(
  handle: TenantHandle,
  applicationId: string,
): Promise<CaptchaRequestRow[]> {
  return handle.run((tx) =>
    tx
      .select()
      .from(captchaRequests)
      .where(
        and(
          eq(captchaRequests.tenantId, handle.tenantId),
          eq(captchaRequests.applicationId, applicationId),
        ),
      )
      .orderBy(desc(captchaRequests.createdAt), desc(captchaRequests.id)),
  );
}

export async function updateCaptchaRequest(
  handle: TenantHandle,
  id: string,
  patch: CaptchaPatch,
): Promise<CaptchaRequestRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(captchaRequests)
      .set(patch)
      .where(and(eq(captchaRequests.tenantId, handle.tenantId), eq(captchaRequests.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

/** Atomically adds one to `attempts[stage]` and returns the row. */
export async function incrementCaptchaAttempt(
  handle: TenantHandle,
  id: string,
  stage: CaptchaStage,
): Promise<CaptchaRequestRow | null> {
  const rows = await handle.run((tx) =>
    tx
      .update(captchaRequests)
      .set({
        attempts: sql`jsonb_set(${captchaRequests.attempts}, array[${stage}::text], to_jsonb(coalesce((${captchaRequests.attempts}->>${stage})::int, 0) + 1))`,
      })
      .where(and(eq(captchaRequests.tenantId, handle.tenantId), eq(captchaRequests.id, id)))
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * Looks up a request by the sha256 of its token within the tenant (the tenant is first learned
 * from `Db.resolveCaptchaToken`).
 */
export async function getCaptchaRequestByTokenHash(
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
        ),
      ),
  );
  return rows[0] ?? null;
}

/** True when the user has a human-stage request that is neither resolved nor expired nor past its expiry. */
export async function hasOpenHumanCaptcha(
  handle: TenantHandle,
  userId: string,
  now: Date,
): Promise<boolean> {
  const rows = await handle.run((tx) =>
    tx
      .select({ id: captchaRequests.id })
      .from(captchaRequests)
      .where(
        and(
          eq(captchaRequests.tenantId, handle.tenantId),
          eq(captchaRequests.userId, userId),
          eq(captchaRequests.stage, 'human'),
          isNull(captchaRequests.resolvedAt),
          isNull(captchaRequests.expiredAt),
          gt(captchaRequests.expiresAt, now),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}
