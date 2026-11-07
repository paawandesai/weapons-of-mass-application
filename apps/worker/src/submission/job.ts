import {
  activity,
  applicationFileKey,
  deleteFile,
  getApplication,
  getCompany,
  getFile,
  getJob,
  getProfileVersion,
  getUserById,
  listAppliedCompanyNames,
  listRunCandidates,
  lockForAttempt,
  putFile,
  updateApplication,
  vault,
  type ApplicationRow,
  type Db,
  type JobRow,
  type TenantHandle,
} from '@wma/db';
import { Judgment, parseAtsJobUrl, profileDocumentSchema } from '@wma/shared';
import { ensureAccount } from './accounts';
import { resolveCaptcha } from './captcha';
import { awaitConfirmation, findConfirmationEmail, type ConfirmationSource } from './confirmation';
import {
  CONFIRM_CAP_S,
  DEFAULT_TIMEZONE,
  CONFIRM_POLL_S,
  MAX_FAILED_ATTEMPTS,
  SUBMIT_CONCURRENCY,
} from './constants';
import type { ContextLike, PageLike, SubmissionDeps } from './deps';
import {
  describeError,
  InfrastructureError,
  isInfrastructureError,
  SubmissionFailure,
} from './failure';
import { scheduleFollowUp } from './followup';
import { enterVerificationCode, waitForVerification } from './accounts/verification';
import { pollUntil } from './poll';
import { planFill } from './fill';
import { recordStep } from './record';
import type { SubmissionContext, SubmitTrace } from './types';
import { meterLlm } from '../llm-usage';
import { guardedJob } from '../guarded';

export interface SubmissionJobData {
  tenantId: string;
  userId: string;
  applicationId: string;
}

export type SubmissionOutcome =
  | { outcome: 'applied'; source: ConfirmationSource; prior: boolean }
  | { outcome: 'pending'; reason: string }
  | { outcome: 'closed'; reason: string }
  | { outcome: 'duplicate'; why: 'locked' | 'not_pending' | 'missing' | 'in_progress' }
  | { outcome: 'skipped'; reason: 'profile_not_approved' };

/** Holds a session-level advisory lock on its own connection for the length of one attempt. */
async function tryAttemptLock(
  db: Db,
  applicationId: string,
): Promise<(() => Promise<void>) | null> {
  const client = await db.pool.connect();
  let release = (err?: Error) => client.release(err);
  try {
    const r = await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as ok',
      [`submit-application:${applicationId}`],
    );
    if (!r.rows[0]?.ok) {
      client.release();
      return null;
    }
  } catch (e) {
    client.release(e instanceof Error ? e : new Error('lock failed'));
    throw e;
  }
  return async () => {
    try {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
        `submit-application:${applicationId}`,
      ]);
    } catch (e) {
      release = (err) =>
        client.release(err ?? (e instanceof Error ? e : new Error('unlock failed')));
    }
    release();
  };
}

async function logDuplicate(
  handle: TenantHandle,
  userId: string,
  applicationId: string,
  why: string,
  detail: Record<string, unknown>,
  attach: boolean,
): Promise<void> {
  await activity.logActivity(handle, {
    userId,
    // An entry attached to the row would wait on a lock someone else holds on it.
    applicationId: attach ? applicationId : null,
    actor: 'agent',
    action: 'duplicate_enqueue',
    detail: { application_id: applicationId, why, ...detail },
  });
}

async function runCandidateJudgment(
  handle: TenantHandle,
  app: ApplicationRow,
  job: JobRow,
): Promise<Judgment | null> {
  if (!app.runId) return null;
  const candidates = await listRunCandidates(handle, app.runId);
  const ref = parseAtsJobUrl(job.url);
  const match = candidates.find(
    (c) =>
      c.url === job.url ||
      (job.ats && job.atsJobId && c.ats === job.ats && c.atsJobId === job.atsJobId) ||
      (ref && c.atsJobId === ref.atsJobId),
  );
  const parsed = Judgment.safeParse(match?.judgment);
  return parsed.success ? parsed.data : null;
}

async function companyNameFor(ctx: SubmissionContext): Promise<string> {
  if (ctx.job.companyId) {
    const company = await getCompany(ctx.handle, ctx.job.companyId);
    if (company) return company.name;
  }
  return parseAtsJobUrl(ctx.job.url)?.boardSlug ?? new URL(ctx.job.url).hostname;
}

const NON_VENDOR_HOST =
  /(^|\.)(recaptcha\.net|hcaptcha\.com|google\.com|gstatic\.com|google-analytics\.com)$/i;

/** True when the trace shows a POST to a host other than a CAPTCHA provider or Google (rule 38). */
export function postedToVendor(trace: SubmitTrace | void): boolean {
  return (trace?.posts ?? []).some((p) => !NON_VENDOR_HOST.test(p.host.replace(/:\d+$/, '')));
}

/** Stores the screenshot and writes the one `submit-trace` entry (rule 36). */
async function recordTrace(ctx: SubmissionContext, trace: SubmitTrace | void): Promise<void> {
  if (!trace) return;
  const attempt = ctx.application.attemptCount + 1;
  let screenshot: string | null = null;
  if (trace.screenshot) {
    try {
      const key = applicationFileKey(
        ctx.handle.tenantId,
        ctx.application.id,
        `submit-${attempt}.png`,
      );
      await ctx.files.put(key, trace.screenshot);
      screenshot = key;
    } catch {
      // the trace is evidence; losing the picture does not fail the attempt
    }
  }
  await recordStep(ctx, {
    action: 'submit-trace',
    detail: {
      posts: trace.posts,
      console: trace.console,
      screenshot,
      ...(trace.clicks ? { clicks: trace.clicks } : {}),
    },
  });
}

/** Records the outcome of a failed step: pending with a retry, or closed on the second failure. */
async function failAttempt(
  ctx: SubmissionContext,
  page: PageLike | null,
  reason: string,
  detail: Record<string, unknown>,
): Promise<SubmissionOutcome> {
  const attempt = ctx.application.attemptCount + 1;
  let screenshot: string | undefined;
  if (page) {
    try {
      const key = applicationFileKey(
        ctx.handle.tenantId,
        ctx.application.id,
        `failure-${attempt}.png`,
      );
      await ctx.files.put(key, await page.screenshot({ fullPage: true }));
      screenshot = key;
    } catch {
      // the page may already be gone; the reason is still recorded
    }
  }
  // unsupported-ats is never retried, so it is never closed by the retry count either.
  const closing = reason !== 'unsupported-ats' && attempt >= MAX_FAILED_ATTEMPTS;
  await ctx.handle.transaction(async (h) => {
    const row = await updateApplication(
      h,
      ctx.application.id,
      closing
        ? {
            status: 'closed',
            closedReason: 'submission-failed',
            pendingReason: reason,
            attemptCount: attempt,
          }
        : { status: 'pending', pendingReason: reason, attemptCount: attempt },
    );
    if (row) ctx.application = row;
    await activity.logActivity(h, {
      userId: ctx.userId,
      applicationId: ctx.application.id,
      actor: 'agent',
      action: reason,
      detail: { ...detail, attempt, ...(screenshot ? { screenshot } : {}) },
    });
    if (closing) {
      await activity.logActivity(h, {
        userId: ctx.userId,
        applicationId: ctx.application.id,
        actor: 'agent',
        action: 'closed',
        detail: { reason: 'submission-failed', last_reason: reason, attempt },
      });
    }
  });
  return closing
    ? { outcome: 'closed', reason: 'submission-failed' }
    : { outcome: 'pending', reason };
}

async function markApplied(
  deps: SubmissionDeps,
  ctx: SubmissionContext,
  source: ConfirmationSource,
  extra: Record<string, unknown>,
): Promise<SubmissionOutcome> {
  const appliedAt = deps.clock.now();
  // The applied row with no `follow_up_enqueued_at` is the outbox record: if the process dies
  // before the enqueue below, the reconciliation pass queues the follow-up.
  await recordStep(ctx, {
    action: 'submitted',
    detail: { source, ...extra },
    patch: { status: 'applied', appliedAt, confirmationSource: source, pendingReason: null },
  });
  try {
    await scheduleFollowUp(
      ctx.handle,
      deps.followUp,
      { tenantId: ctx.handle.tenantId, userId: ctx.userId, applicationId: ctx.application.id },
      appliedAt,
    );
  } catch (e) {
    try {
      await recordStep(ctx, { action: 'follow-up-not-scheduled', detail: describeError(e) });
    } catch {
      // the outcome is committed; reconciliation still owes the follow-up
    }
  }
  return { outcome: 'applied', source, prior: extra.prior === true };
}

async function attempt(
  deps: SubmissionDeps,
  handle: TenantHandle,
  claim: ApplicationRow,
  approvedVersion: number,
): Promise<SubmissionOutcome> {
  const userId = claim.userId;
  const job = await getJob(handle, claim.jobId);
  if (!job) {
    await handle.transaction(async (h) => {
      await updateApplication(h, claim.id, { status: 'closed', closedReason: 'job_missing' });
      await activity.logActivity(h, {
        userId,
        applicationId: claim.id,
        actor: 'agent',
        action: 'closed',
        detail: { reason: 'job_missing' },
      });
    });
    return { outcome: 'closed', reason: 'job_missing' };
  }

  let profile;
  try {
    profile = profileDocumentSchema.parse(
      (await getProfileVersion(handle, userId, approvedVersion)).document,
    );
  } catch (e) {
    // No outcome can be recorded without the profile; the queue retries the job.
    throw new InfrastructureError('profile_load_failed', { cause: e });
  }
  const ctx: SubmissionContext = {
    handle,
    userId,
    application: claim,
    job,
    companyName: '',
    priorApplications: [],
    profile,
    judgment: await runCandidateJudgment(handle, claim, job),
    clock: deps.clock,
    gmail: deps.gmail(handle, userId),
    mail: deps.sendMail(handle, userId),
    llm: meterLlm(handle, userId, 'application', deps.llm, claim.id),
    files: {
      put: (key, bytes) => putFile(handle, key, bytes),
      get: (key) => getFile(handle, key),
      delete: (key) => deleteFile(handle, key),
    },
    vault: {
      get: (ref) => vault.get(handle, userId, 'ats_password', ref),
      put: (ref, value) => vault.put(handle, userId, 'ats_password', ref, value),
    },
  };

  ctx.companyName = await companyNameFor(ctx);
  ctx.priorApplications = await listAppliedCompanyNames(handle, userId);

  // Evidence of earlier attempts: the first start, and the first time a submit was about to be
  // clicked. The second is what makes a vendor-side submission possible.
  const history = await activity.listByApplication(handle, claim.id, { limit: 500 });
  const earliest = (action: string): Date | null => {
    const times = history.filter((e) => e.action === action).map((e) => e.at.getTime());
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  };
  const priorSince =
    earliest('submission-started') ?? (claim.attemptCount > 0 ? claim.createdAt : null);
  const submittingAt = earliest('submitting');

  let context: ContextLike | null = null;
  let page: PageLike | null = null;
  const openPage = async (): Promise<PageLike> => {
    if (page) return page;
    const browser = await deps.launchBrowser();
    const timezoneId = await getUserById(handle, userId)
      .then((u) => u.timezone || DEFAULT_TIMEZONE)
      .catch(() => DEFAULT_TIMEZONE);
    context = await browser.newContext({ timezoneId });
    page = await context.newPage();
    return page;
  };
  try {
    await recordStep(ctx, {
      action: 'submission-started',
      detail: { attempt: claim.attemptCount + 1 },
    });

    const adapter = deps.selectAdapter(job.url);
    if (!adapter)
      throw new SubmissionFailure('unsupported-ats', { host: new URL(job.url).hostname });

    if (priorSince) {
      const prior = await findConfirmationEmail(ctx, priorSince);
      if (prior)
        return await markApplied(deps, ctx, 'email', { prior: true, message_id: prior.id });
    }
    if (submittingAt) {
      // A submit may have gone through before the last attempt died: look at the vendor page,
      // then give the confirmation email the rest of its window before filling anything again.
      const onPage = await openPage();
      const vendorConfirmed = await adapter
        .load(onPage, job.url)
        .then(() => adapter.confirmed(onPage))
        .catch(() => false);
      if (vendorConfirmed) return await markApplied(deps, ctx, 'page', { prior: true });
      const remainingMs = Math.max(
        0,
        submittingAt.getTime() + CONFIRM_CAP_S * 1000 - deps.clock.now().getTime(),
      );
      const mail = await pollUntil(
        deps.clock,
        { intervalMs: CONFIRM_POLL_S * 1000, capMs: remainingMs },
        () => findConfirmationEmail(ctx, submittingAt),
      );
      if (mail) return await markApplied(deps, ctx, 'email', { prior: true, message_id: mail.id });
    }

    const tailored = await deps.tailor(ctx);
    if (!tailored.ok) {
      throw new SubmissionFailure(tailored.reason, {
        detail: tailored.detail,
        failures: tailored.failures.slice(0, 5),
      });
    }
    await recordStep(ctx, {
      action: 'tailored',
      detail: {
        page_count: tailored.pageCount,
        regenerated: tailored.regenerated,
        unmet_requirements: tailored.unmetRequirements.length,
      },
      patch: { resumePdfRef: tailored.pdfKey, unmetRequirements: tailored.unmetRequirements },
    });

    const formPage = await openPage();
    await adapter.load(formPage, job.url);

    if (await adapter.requiresAccount(formPage)) {
      const user = await getUserById(handle, userId);
      await ensureAccount(ctx, adapter, formPage, user.email);
    }

    const captchaOpts = { webOrigin: deps.webOrigin, companyName: ctx.companyName };
    // Design rule 15: what the form says about itself (an application limit) is recorded, and
    // does not stop the submission.
    for (const notice of (await adapter.notices?.(formPage)) ?? []) {
      await recordStep(ctx, { action: 'form-notice', detail: { ...notice } });
    }
    const fields = await adapter.fields(formPage);
    const plan = planFill(fields, await deps.resolveAnswers(ctx, fields));
    const pdfKey = ctx.application.resumePdfRef;
    let pdf: Buffer | null = null;
    if (plan.resumeField) {
      pdf = pdfKey ? await ctx.files.get(pdfKey) : null;
      if (!pdf) throw new SubmissionFailure('browser-error', { detail: 'resume_missing' });
      plan.answers[plan.resumeField.label] = { attached: 'resume.pdf' };
    }
    // The resume goes in before the form is filled or advanced: a stepped form validates its
    // required upload when Next is pressed.
    if (pdf) await adapter.attachResume(formPage, { filename: 'resume.pdf', bytes: pdf });
    await adapter.fill(formPage, plan.values);
    // Rule 7: the answers reach the row with the `filled` entry in one transaction, before submit.
    await recordStep(ctx, {
      action: 'filled',
      detail: { fields: fields.length },
      patch: { formAnswers: plan.answers },
    });

    const blocking = await adapter.findCaptcha(formPage);
    if (blocking) await resolveCaptcha(ctx, blocking, captchaOpts);

    await recordStep(ctx, { action: 'submitting' });
    const submittedAt = deps.clock.now();
    let trace = await adapter.submit(formPage);
    await recordTrace(ctx, trace);
    for (let round = 0; round < 2; round++) {
      const challenge = await adapter.findCaptcha(formPage);
      if (!challenge) break;
      await resolveCaptcha(ctx, challenge, captchaOpts);
      if (await adapter.confirmed(formPage)) continue;
      // Rule 38: a second click could duplicate an application the vendor already received.
      if (postedToVendor(trace)) {
        await recordStep(ctx, {
          action: 'submit-skipped',
          detail: { reason: 'vendor-post-seen' },
        });
        continue;
      }
      trace = await adapter.submit(formPage);
      await recordTrace(ctx, trace);
    }

    // Rule 40: a page that asks for an emailed code is answered from Gmail, then the same submit
    // is clicked again (each click mails a fresh code). This is not the rule 38 second click.
    let clickedAt = submittedAt;
    let verifications = 0;
    const verifyByEmail = async (): Promise<boolean> => {
      if (verifications >= 2 || !(await adapter.codePrompt?.(formPage))) return false;
      verifications++;
      const found = await waitForVerification(ctx, clickedAt, { newest: true });
      await recordStep(ctx, { action: 'email-verification', detail: { source: found.kind } });
      if (found.kind === 'code') {
        await enterVerificationCode(formPage, found.code);
        await adapter.advanceCode?.(formPage);
        clickedAt = deps.clock.now();
        const again = await adapter.submit(formPage).catch((e: unknown) => {
          // Enter alone may already have submitted; a vanished button is then not a failure.
          if (e instanceof SubmissionFailure && e.reason === 'unmapped-field') return undefined;
          throw e;
        });
        await recordTrace(ctx, again);
      } else {
        const linkPage = await (context as ContextLike | null)!.newPage();
        await linkPage.goto(found.url);
      }
      return true;
    };
    const confirmation = await awaitConfirmation(
      ctx,
      adapter,
      formPage,
      submittedAt,
      verifyByEmail,
    );
    if (!confirmation) throw new SubmissionFailure('unconfirmed', { waited_s: 600 });
    return await markApplied(deps, ctx, confirmation.source, {
      ...(confirmation.messageId ? { message_id: confirmation.messageId } : {}),
    });
  } catch (e) {
    // Infrastructure failures leave no outcome on the row; the queue retries the whole job.
    if (isInfrastructureError(e)) throw e;
    // Awaited, so the context is not closed while the failure screenshot is being taken.
    if (e instanceof SubmissionFailure) return await failAttempt(ctx, page, e.reason, e.detail);
    return await failAttempt(ctx, page, 'browser-error', describeError(e));
  } finally {
    await (context as ContextLike | null)?.close().catch(() => {});
  }
}

/**
 * One submission attempt for one application. Never throws for an application-level failure;
 * the outcome says what was recorded. The attempt is serialized per application: an advisory
 * lock for its whole length, and `for update skip locked` for the claim.
 */
export async function runSubmission(
  deps: SubmissionDeps,
  db: Db,
  data: SubmissionJobData,
): Promise<SubmissionOutcome> {
  const handle = db.forTenant(data.tenantId);
  const unlock = await tryAttemptLock(db, data.applicationId);
  if (!unlock) {
    await logDuplicate(handle, data.userId, data.applicationId, 'in_progress', {}, true);
    return { outcome: 'duplicate', why: 'in_progress' };
  }
  try {
    const claim = await handle.transaction((h) => lockForAttempt(h, data.applicationId));
    if (!claim) {
      const exists = await getApplication(handle, data.applicationId);
      const why = exists ? 'locked' : 'missing';
      await logDuplicate(handle, data.userId, data.applicationId, why, {}, false);
      return { outcome: 'duplicate', why };
    }
    if (claim.status !== 'pending') {
      await logDuplicate(
        handle,
        claim.userId,
        claim.id,
        'not_pending',
        { status: claim.status },
        true,
      );
      return { outcome: 'duplicate', why: 'not_pending' };
    }
    const guarded = await guardedJob('submit-application', ({ approvedVersion }) =>
      attempt(deps, handle, claim, approvedVersion),
    )({ handle, userId: claim.userId });
    return guarded.ran ? guarded.result : { outcome: 'skipped', reason: guarded.reason };
  } finally {
    await unlock();
  }
}

class Semaphore {
  private waiting: Array<() => void> = [];
  private free: number;
  constructor(size: number) {
    this.free = size;
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/** Runs attempts with at most `concurrency` in flight, so at most that many contexts are open. */
export function createSubmissionRunner(
  deps: SubmissionDeps,
  db: Db,
  opts: { concurrency?: number } = {},
) {
  const gate = new Semaphore(opts.concurrency ?? SUBMIT_CONCURRENCY);
  return {
    run: (data: SubmissionJobData) => gate.use(() => runSubmission(deps, db, data)),
  };
}
