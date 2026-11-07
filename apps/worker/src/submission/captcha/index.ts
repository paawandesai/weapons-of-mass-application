import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  activity,
  applicationFileKey,
  getCaptchaRequest,
  extendHumanReservation,
  getUserById,
  incrementCaptchaAttempt,
  insertCaptchaRequest,
  reissueHumanToken,
  reserveHumanStage,
  updateCaptchaRequest,
  type CaptchaRequestRow,
  type CaptchaStage,
} from '@wma/db';
import { loadPrompt } from '@wma/llm';
import { sendEmailRecovering } from '@wma/shared';
import {
  HUMAN_WINDOW_S,
  MAX_AGENT_ATTEMPTS,
  MAX_HUMAN_ATTEMPTS,
  WORKER_POLL_S,
} from '../constants';
import { SubmissionFailure } from '../failure';
import type { CaptchaHandle, SubmissionContext } from '../types';
import { captchaEmail } from './email';

export { captchaEmail } from './email';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/** Stage prompts: separate instructions and no shared history between the two solvers. */
const AGENT_PROMPTS = { agent1: 'solve-captcha-a', agent2: 'solve-captcha-b' } as const;
const AnswerSchema = z.object({ answer: z.string().max(64) });

export interface CaptchaOptions {
  webOrigin: string;
  companyName: string;
}

export interface CaptchaOutcome {
  requestId: string;
  resolvedBy: CaptchaStage;
  attempts: Record<string, number>;
}

/** Raised when a browser operation outlives the human window. */
class WindowClosed extends Error {}

/** Runs a browser operation but gives up when the human window has this long left. */
async function within<T>(remainingMs: number, work: Promise<T>): Promise<T> {
  if (remainingMs <= 0) {
    work.catch(() => {});
    throw new WindowClosed();
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WindowClosed()), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}

const attemptsOf = (row: CaptchaRequestRow) => row.attempts as Record<string, number>;

/** Stores the image under the application's folder; the name is the next free `captcha-<n>.png`. */
async function saveImage(ctx: SubmissionContext, png: Buffer): Promise<string> {
  for (let n = 1; ; n++) {
    const key = applicationFileKey(ctx.handle.tenantId, ctx.application.id, `captcha-${n}.png`);
    if ((await ctx.files.get(key)) === null) {
      await ctx.files.put(key, png);
      return key;
    }
  }
}

async function log(
  ctx: SubmissionContext,
  action: string,
  detail: Record<string, unknown>,
  patch?: { requestId: string; set: Parameters<typeof updateCaptchaRequest>[2] },
): Promise<CaptchaRequestRow | null> {
  return ctx.handle.transaction(async (h) => {
    const row = patch ? await updateCaptchaRequest(h, patch.requestId, patch.set) : null;
    await activity.logActivity(h, {
      userId: ctx.userId,
      applicationId: ctx.application.id,
      actor: 'agent',
      action,
      detail,
    });
    return row;
  });
}

async function markResolved(
  ctx: SubmissionContext,
  req: CaptchaRequestRow,
  by: CaptchaStage,
): Promise<CaptchaOutcome> {
  const attempts = attemptsOf((await getCaptchaRequest(ctx.handle, req.id)) ?? req);
  await log(
    ctx,
    'captcha-resolved',
    { request_id: req.id, resolved_by: by, attempts },
    { requestId: req.id, set: { resolvedBy: by, resolvedAt: ctx.clock.now() } },
  );
  return { requestId: req.id, resolvedBy: by, attempts };
}

async function agentStage(
  ctx: SubmissionContext,
  captcha: CaptchaHandle,
  req: CaptchaRequestRow,
  stage: 'agent1' | 'agent2',
  firstImage: Buffer,
): Promise<boolean> {
  const name = AGENT_PROMPTS[stage];
  const system = loadPrompt(name, 'v1');
  for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS; attempt++) {
    const png = attempt === 1 ? firstImage : await captcha.screenshot();
    let answer = '';
    try {
      const res = await ctx.llm.generateStructured({
        prompt: `${name}/v1`,
        system,
        user: 'Read the challenge in the image.',
        images: [{ mediaType: 'image/png', data: png.toString('base64') }],
        schema: AnswerSchema,
        maxTokens: 200,
      });
      const parsed = AnswerSchema.safeParse(res.output);
      if (parsed.success) answer = parsed.data.answer.trim();
    } catch {
      // a failed call is a failed attempt
    }
    await incrementCaptchaAttempt(ctx.handle, req.id, stage);
    if (!answer) continue;
    await captcha.enter(answer);
    if (await captcha.cleared()) return true;
  }
  return false;
}

async function expire(
  ctx: SubmissionContext,
  req: CaptchaRequestRow,
  action: 'captcha-timeout' | 'captcha-parked',
  detail: Record<string, unknown>,
): Promise<never> {
  const now = ctx.clock.now();
  const row = await getCaptchaRequest(ctx.handle, req.id);
  await log(
    ctx,
    action,
    { request_id: req.id, attempts: row ? attemptsOf(row) : undefined, ...detail },
    { requestId: req.id, set: { expiredAt: now } },
  );
  throw new SubmissionFailure('captcha-timeout', { request_id: req.id, ...detail });
}

/** Thrown when the challenge email was blocked by a guard or its delivery is unresolved. */
class ChallengeEmailFailed extends Error {}

async function sendChallenge(
  ctx: SubmissionContext,
  opts: CaptchaOptions,
  email: string,
  token: string,
  png: Buffer,
  requestId: string,
  attempt: number,
): Promise<void> {
  const result = await sendEmailRecovering(ctx.mail, {
    userId: ctx.userId,
    kind: 'captcha_request',
    applicationId: ctx.application.id,
    deliveryKey: `captcha_request:${requestId}:${attempt}`,
    to: email,
    ...captchaEmail({
      companyName: opts.companyName,
      jobTitle: ctx.job.title,
      link: `${opts.webOrigin.replace(/\/+$/, '')}/captcha/${token}`,
      image: png,
    }),
  });
  // A blocked or unresolved send never reached the user: it counts as a failed email.
  if (result.status !== 'sent') throw new ChallengeEmailFailed(result.status);
}

async function humanStage(
  ctx: SubmissionContext,
  captcha: CaptchaHandle,
  req: CaptchaRequestRow,
  opts: CaptchaOptions,
): Promise<CaptchaOutcome> {
  const windowMs = HUMAN_WINDOW_S * 1000;
  const png0 = await captcha.screenshot();
  const imageRef = await saveImage(ctx, png0);
  let token = newToken();
  const now0 = ctx.clock.now();
  const slot = await reserveHumanStage(ctx.handle, {
    requestId: req.id,
    userId: ctx.userId,
    tokenHash: hashToken(token),
    imageRef,
    expiresAt: new Date(now0.getTime() + windowMs),
    now: now0,
  });
  if (slot === 'busy') return expire(ctx, req, 'captcha-parked', { parked: true });

  const user = await getUserById(ctx.handle, ctx.userId);
  let emailAttempt = 0;
  try {
    await sendChallenge(ctx, opts, user.email, token, png0, req.id, 0);
  } catch {
    return expire(ctx, req, 'captcha-timeout', { detail: 'email_failed' });
  }
  // The window is measured from the send. The extension runs under the per-user lock and checks
  // that this worker still owns the reservation (a stalled send may have lost it).
  const extended = await extendHumanReservation(ctx.handle, {
    requestId: req.id,
    userId: ctx.userId,
    tokenHash: hashToken(token),
    windowMs,
  });
  if (!extended) return expire(ctx, req, 'captcha-timeout', { detail: 'reservation_lost' });
  const windowEnd = new Date(ctx.clock.now().getTime() + windowMs);
  await log(ctx, 'captcha-human-requested', {
    request_id: req.id,
    expires_at: windowEnd.toISOString(),
  });
  const remaining = () => windowEnd.getTime() - ctx.clock.now().getTime();

  for (;;) {
    const row = await getCaptchaRequest(ctx.handle, req.id);
    if (row?.humanAnswer) {
      // An answer that is only picked up after the deadline is not entered.
      if (remaining() <= 0) return expire(ctx, req, 'captcha-timeout', {});
      const answer = row.humanAnswer;
      const after = await incrementCaptchaAttempt(ctx.handle, req.id, 'human');
      try {
        await within(remaining(), captcha.enter(answer));
        if (await within(remaining(), captcha.cleared())) return markResolved(ctx, req, 'human');
      } catch (e) {
        if (e instanceof WindowClosed) return expire(ctx, req, 'captcha-timeout', {});
        throw e;
      }
      if (
        ((after?.attempts as Record<string, number> | undefined)?.human ?? 0) >= MAX_HUMAN_ATTEMPTS
      ) {
        return expire(ctx, req, 'captcha-timeout', { detail: 'human_attempts_exhausted' });
      }
      if (remaining() <= 0) return expire(ctx, req, 'captcha-timeout', {});
      // Wrong answer: a fresh image and a fresh single-use token.
      let png: Buffer;
      try {
        png = await within(remaining(), captcha.screenshot());
      } catch (e) {
        if (e instanceof WindowClosed) return expire(ctx, req, 'captcha-timeout', {});
        throw e;
      }
      token = newToken();
      await reissueHumanToken(ctx.handle, req.id, {
        tokenHash: hashToken(token),
        imageRef: await saveImage(ctx, png),
      });
      try {
        await sendChallenge(ctx, opts, user.email, token, png, req.id, ++emailAttempt);
      } catch {
        return expire(ctx, req, 'captcha-timeout', { detail: 'email_failed' });
      }
      await log(ctx, 'captcha-human-resent', { request_id: req.id });
      continue;
    }
    if (remaining() <= 0) return expire(ctx, req, 'captcha-timeout', {});
    await ctx.clock.sleep(WORKER_POLL_S * 1000);
  }
}

/**
 * Takes a detected challenge through the chain: three attempts by solver one, three by solver
 * two, then the user by email. Throws `captcha-timeout` when no stage resolves it.
 */
export async function resolveCaptcha(
  ctx: SubmissionContext,
  captcha: CaptchaHandle,
  opts: CaptchaOptions,
): Promise<CaptchaOutcome> {
  const png = await captcha.screenshot();
  const imageRef = await saveImage(ctx, png);
  const req = await ctx.handle.transaction(async (h) => {
    const row = await insertCaptchaRequest(h, {
      userId: ctx.userId,
      applicationId: ctx.application.id,
      imageRef,
      stage: 'agent1',
    });
    await activity.logActivity(h, {
      userId: ctx.userId,
      applicationId: ctx.application.id,
      actor: 'agent',
      action: 'captcha-detected',
      detail: { request_id: row.id, image_ref: imageRef },
    });
    return row;
  });

  let image = png;
  for (const stage of ['agent1', 'agent2'] as const) {
    if (await agentStage(ctx, captcha, req, stage, image)) return markResolved(ctx, req, stage);
    const next = stage === 'agent1' ? 'agent2' : 'human';
    if (next === 'agent2') {
      await log(
        ctx,
        'captcha-stage',
        { request_id: req.id, from: stage, to: next },
        { requestId: req.id, set: { stage: next } },
      );
      image = await captcha.screenshot();
    } else {
      await log(ctx, 'captcha-stage', { request_id: req.id, from: stage, to: next });
    }
  }
  return humanStage(ctx, captcha, req, opts);
}
