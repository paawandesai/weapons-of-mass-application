import type { Locator, Page } from 'playwright';
import { applicationFileKey } from '@wma/db';
import type { AtsId } from '@wma/shared';
import { SubmissionFailure, sanitizeMessage } from '../failure';
import type {
  Account,
  CaptchaHandle,
  Credential,
  FieldDescriptor,
  FieldValues,
  FormAdapter,
  FormNotice,
  SignInOutcome,
  SubmissionContext,
  SubmitTrace,
} from '../types';
import {
  attachResumeGeneric,
  describe,
  enrichOptions,
  fillPage,
  findFrameCaptcha,
  goToStep,
  probePage,
  readNotices,
  recordBaseline,
  scanPage,
  settlePage,
} from './generic';

export interface AccountSpec {
  /** Present on the sign-up and sign-in pages. */
  form: string;
  email: string;
  password: string;
  confirmPassword?: string;
  terms?: string;
  signUpSubmit: string;
  signInSubmit: string;
  toSignUp: string;
  toSignIn: string;
  error: string;
  /** Shown after a successful sign-up while the verification email is pending. */
  verificationSent: string;
}

/**
 * What a vendor file may say about its hosted forms. Reading, filling and submitting the form is
 * the generic page layer's job (generic.ts); there are no scan selectors here.
 */
export interface VendorHints {
  ats: AtsId;
  hosts: RegExp;
  /** Maps a posting URL to the page that holds the form. */
  applyUrl?(url: URL): string;
  /** The vendor's own confirmation marker; the generic text check applies when it is absent. */
  confirmation: { selector: string; url?: RegExp };
  /** Candidate account pages (Greenhouse); null when the vendor has none. */
  account: AccountSpec | null;
  /** Optional override for the resume file input. */
  resumeInput?: string;
}

export const CAPTCHA_SELECTOR = '[data-captcha], #captcha-widget, .captcha-widget';

const LOAD_TIMEOUT_MS = 20_000;
const CONFIRM_TIMEOUT_MS = 2_500;
const SIGN_IN_TIMEOUT_MS = 10_000;

/** The posting host is a hosted vendor form; non-http(s) URLs never are. */
export function hostMatches(url: string, hosts: RegExp): boolean {
  try {
    const u = new URL(url.trim());
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') && hosts.test(u.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function captchaHandle(page: Page, widget: Locator): CaptchaHandle {
  return {
    screenshot: () => widget.screenshot({ type: 'png' }),
    async enter(answer) {
      await widget.locator('input[type="text"], input:not([type])').first().fill(answer);
      const verify = widget.locator('button[data-captcha-verify], button:has-text("Verify")');
      if (await verify.count()) await verify.first().click();
      else await page.keyboard.press('Enter');
    },
    cleared: async () =>
      !(await widget
        .first()
        .isVisible()
        .catch(() => false)),
  };
}

export async function findCaptchaOn(page: Page): Promise<CaptchaHandle | null> {
  const widget = page.locator(CAPTCHA_SELECTOR).first();
  if (!(await widget.isVisible().catch(() => false))) return null;
  return captchaHandle(page, widget);
}

/**
 * Stores a full-page failure screenshot under the application's folder and returns its key,
 * or null when the page cannot be captured (a crashed page must not mask the original failure).
 * `name` is the failure number or label: `1` stores `failure-1.png`; a name ending in `.png`
 * is used as given.
 */
export async function screenshotOnFailure(
  page: Page,
  ctx: Pick<SubmissionContext, 'handle' | 'application' | 'files'>,
  name: string,
): Promise<string | null> {
  const file = name.endsWith('.png') ? name : `failure-${name}.png`;
  const key = applicationFileKey(ctx.handle.tenantId, ctx.application.id, file);
  try {
    await ctx.files.put(key, await page.screenshot({ fullPage: true, type: 'png' }));
    return key;
  } catch {
    return null;
  }
}

function hasValue(v: FieldValues[string] | undefined, f: FieldDescriptor): boolean {
  if (v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return f.type === 'checkbox' ? v === true : true;
}

/**
 * Required fields the form cannot be completed without but that have no value: the input to the
 * `unmapped-field` outcome. Resume fields are covered by attachResume and self-identification
 * fields are never required of us; a required upload other than the resume can never be mapped.
 */
export function findUnmappedRequired(
  fields: FieldDescriptor[],
  values: FieldValues,
): FieldDescriptor[] {
  return fields.filter((f) => {
    if (!f.required) return false;
    if (f.classification === 'resume' || f.classification === 'self-identification') return false;
    if (f.type === 'file') return true;
    return !hasValue(values[f.id], f);
  });
}

export interface UnmappedFieldOutcome {
  reason: 'unmapped-field';
  /** The fields to name in the PENDING reason detail. */
  fields: Array<{ id: string; label: string }>;
  screenshotKey: string | null;
}

/** Null when every required field is covered; otherwise the outcome, with the form screenshot stored. */
export async function reportUnmappedFields(
  page: Page,
  ctx: Pick<SubmissionContext, 'handle' | 'application' | 'files'>,
  fields: FieldDescriptor[],
  values: FieldValues,
): Promise<UnmappedFieldOutcome | null> {
  const missing = findUnmappedRequired(fields, values);
  if (missing.length === 0) return null;
  const n = String((ctx.application.attemptCount ?? 0) + 1);
  return {
    reason: 'unmapped-field',
    fields: missing.map((f) => ({ id: f.id, label: f.label })),
    screenshotKey: await screenshotOnFailure(page, ctx, n),
  };
}

const SUBMIT_WINDOW_MS = 10_000;
/** A validation error that was already showing before the click and is still there this long after. */
const PERSISTING_ERROR_MS = 1_500;
const POLL_MS = 250;
const ENABLE_WAIT_MS = 1_500;

const unmapped = (field: { id: string; label: string }) =>
  new SubmissionFailure('unmapped-field', { field: field.label, fields: [field] });

const CODE_PROMPT_TEXT =
  /security code|verification code|one[- ]time code|code (we|that was) sent|enter the (\d-digit )?code|check your (email|inbox)/i;

/**
 * Rule 40: the page shows a code prompt (matching text and a short visible text/number input).
 * Tags the input `data-wma-code` so the verification path can type into it.
 */
async function codePromptOn(page: Page): Promise<boolean> {
  return page
    .evaluate(
      `((source) => {
        const text = new RegExp(source, 'i');
        const shown = (e) => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        document.querySelectorAll('[data-wma-code]').forEach((e) => e.removeAttribute('data-wma-code'));
        const inputs = [...document.querySelectorAll('input')].filter(
          (e) =>
            shown(e) &&
            ['text', 'number', 'tel', ''].includes((e.getAttribute('type') || '').toLowerCase()) &&
            (!e.maxLength || e.maxLength < 0 || e.maxLength <= 12),
        );
        const describe = (e) => {
          const labels = e.labels ? [...e.labels].map((l) => l.textContent || '') : [];
          return [e.getAttribute('aria-label'), e.placeholder, e.name, e.id, ...labels].join(' ');
        };
        const labelled = inputs.find((e) => text.test(describe(e)) || /code/i.test(describe(e)));
        const body = document.body ? document.body.innerText : '';
        const target = labelled || (text.test(body) && inputs.length <= 2 ? inputs[0] : null);
        if (!target || !(text.test(body) || text.test(describe(target)))) return false;
        target.setAttribute('data-wma-code', '1');
        return true;
      })(${JSON.stringify(CODE_PROMPT_TEXT.source)})`,
    )
    .then((v) => v === true)
    .catch(() => false);
}

const TRACE_SHOT_DELAY_MS = 3_000;

/**
 * Rule 36: listens from just before the click for POST requests (host, path, status), console
 * errors and a viewport screenshot 3 s after the click. Evidence only; nothing here decides.
 */
function startTrace(page: Page): { finish(): Promise<SubmitTrace>; stop(): void } {
  const posts: SubmitTrace['posts'] = [];
  const consoleErrors: string[] = [];
  const byRequest = new Map<unknown, SubmitTrace['posts'][number]>();
  const onRequest = (req: { method(): string; url(): string }) => {
    if (req.method() !== 'POST') return;
    let entry: SubmitTrace['posts'][number];
    try {
      const u = new URL(req.url());
      entry = { host: u.host, path: u.pathname, status: null };
    } catch {
      return;
    }
    posts.push(entry);
    byRequest.set(req, entry);
  };
  const onResponse = (res: { request(): unknown; status(): number }) => {
    const entry = byRequest.get(res.request());
    if (entry) entry.status = res.status();
  };
  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === 'error' && consoleErrors.length < 20) {
      consoleErrors.push(sanitizeMessage(msg.text()));
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('console', onConsole);
  const stop = () => {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('console', onConsole);
  };
  const clicked = Date.now();
  return {
    stop,
    async finish() {
      const wait = clicked + TRACE_SHOT_DELAY_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
      stop();
      return { posts, console: consoleErrors, screenshot };
    },
  };
}

/** The generic submitter: vendor hints plus the page layer in generic.ts. */
export class VendorAdapter implements FormAdapter {
  readonly ats: AtsId;

  constructor(protected readonly hints: VendorHints) {
    this.ats = hints.ats;
  }

  detect(url: string): boolean {
    return hostMatches(url, this.hints.hosts);
  }

  private async confirmationShown(page: Page): Promise<boolean> {
    const { selector, url } = this.hints.confirmation;
    if (url?.test(page.url())) return true;
    return page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
  }

  /** The form, an account page or a confirmation is on the page. */
  private async pageReady(page: Page): Promise<boolean> {
    try {
      const account = this.hints.account?.form;
      if (
        account &&
        (await page
          .locator(account)
          .first()
          .isVisible()
          .catch(() => false))
      )
        return true;
      if (await this.confirmationShown(page)) return true;
      const scan = await scanPage(page);
      if (scan.questions.length > 0) return true;
      const probe = await probePage(page);
      return probe.thanks && !probe.controlsLeft;
    } catch {
      return false; // mid-navigation
    }
  }

  private async waitForPage(page: Page, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if (await this.pageReady(page)) return true;
      if (Date.now() - started >= timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async load(page: Page, url: string): Promise<void> {
    let target = url;
    try {
      const u = new URL(url);
      if (this.detect(url) && this.hints.applyUrl) target = this.hints.applyUrl(u);
    } catch {
      // not a URL we can rewrite; navigate as given
    }
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS });
    if (!(await this.waitForPage(page, LOAD_TIMEOUT_MS))) {
      throw new Error('the application form did not appear');
    }
    // Rule 19: a React page is visible before it is interactive; act only once it has settled.
    await settlePage(page);
  }

  async requiresAccount(page: Page): Promise<boolean> {
    const account = this.hints.account;
    if (!account) return false;
    return (await page.locator(account.form).count()) > 0;
  }

  protected account(): AccountSpec {
    if (!this.hints.account) throw new Error(`${this.ats} forms do not use candidate accounts`);
    return this.hints.account;
  }

  async signUp(page: Page, account: Account): Promise<void> {
    const a = this.account();
    if ((await page.locator(a.signUpSubmit).count()) === 0) {
      await page.locator(a.toSignUp).first().click();
      await page.locator(a.signUpSubmit).first().waitFor({ state: 'visible' });
    }
    await page.locator(a.email).first().fill(account.email);
    await page.locator(a.password).first().fill(account.password);
    if (a.confirmPassword && (await page.locator(a.confirmPassword).count())) {
      await page.locator(a.confirmPassword).first().fill(account.password);
    }
    if (a.terms && (await page.locator(a.terms).count())) {
      await page.locator(a.terms).first().check();
    }
    await page.locator(a.signUpSubmit).first().click();
    const failed = page
      .locator(a.error)
      .first()
      .waitFor({ state: 'visible', timeout: SIGN_IN_TIMEOUT_MS })
      .then(async () => {
        throw new Error(
          `sign-up rejected: ${(await page.locator(a.error).first().innerText()).trim()}`,
        );
      });
    const sent = page
      .locator(a.verificationSent)
      .first()
      .waitFor({ state: 'visible', timeout: SIGN_IN_TIMEOUT_MS });
    await Promise.race([failed, sent]);
  }

  async signIn(page: Page, credential: Credential): Promise<SignInOutcome> {
    const a = this.account();
    if ((await page.locator(a.signInSubmit).count()) === 0) {
      await page.locator(a.toSignIn).first().click();
      await page.locator(a.signInSubmit).first().waitFor({ state: 'visible' });
    }
    await page.locator(a.email).first().fill(credential.username);
    await page.locator(a.password).first().fill(credential.password);
    await page.locator(a.signInSubmit).first().click();
    // Neither outcome showing within the timeout rejects: that is an error, not a bad password.
    const formReady = async (): Promise<SignInOutcome> => {
      const started = Date.now();
      for (;;) {
        const scan = await scanPage(page).catch(() => null);
        if (scan && scan.questions.length > 0) {
          await settlePage(page);
          return 'ok';
        }
        if (Date.now() - started > SIGN_IN_TIMEOUT_MS) throw new Error('form did not appear');
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    return Promise.race([
      page
        .locator(a.error)
        .first()
        .waitFor({ state: 'visible', timeout: SIGN_IN_TIMEOUT_MS })
        .then((): SignInOutcome => 'rejected'),
      formReady(),
    ]);
  }

  async fields(page: Page): Promise<FieldDescriptor[]> {
    const scan = await enrichOptions(page, await scanPage(page));
    return scan.questions.map(describe);
  }

  /**
   * Fills what has values, then rescans and compares (design rule 9). A required question whose
   * value did not stick is an `unmapped-field`, raised before submit.
   */
  async fill(page: Page, values: FieldValues): Promise<void> {
    const failed = await fillPage(page, values);
    if (failed.length > 0) {
      throw new SubmissionFailure('unmapped-field', { field: failed[0]!.label, fields: failed });
    }
  }

  async attachResume(page: Page, pdf: { filename: string; bytes: Buffer }): Promise<void> {
    await attachResumeGeneric(page, this.hints.resumeInput, pdf);
  }

  async submit(page: Page): Promise<SubmitTrace> {
    let scan = await scanPage(page);
    if (!scan.submit) throw unmapped({ id: 'submit', label: 'Submit' });
    if (scan.submit.step !== null && scan.steps.active !== scan.submit.step) {
      scan = await goToStep(page, scan.submit.step);
    }
    // Rule 10: a submit that stays disabled after the fill is a field we could not map.
    const button = page.locator('[data-wma-nav="submit"]').first();
    const enabledBy = Date.now() + ENABLE_WAIT_MS;
    for (;;) {
      const disabled = await page
        .evaluate(
          `(() => {
            const e = document.querySelector('[data-wma-nav="submit"]');
            return !e || !!e.disabled || e.getAttribute('aria-disabled') === 'true';
          })()`,
        )
        .catch(() => true);
      if (!disabled) break;
      if (Date.now() >= enabledBy) throw unmapped({ id: 'submit', label: 'Submit' });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // What the page said before the click: only text that appears after it is evidence of this
    // submission, and an error already showing that is still there afterwards is a rejection.
    await recordBaseline(page);
    const before = new Set((await probePage(page).catch(() => null))?.errors ?? []);
    const tracer = startTrace(page);
    try {
      await button.click({ timeout: 5_000 });
      await this.watchSubmitWindow(page, before);
    } catch (e) {
      tracer.stop();
      throw e;
    }
    return tracer.finish();
  }

  /** Rule 12, in order: confirmation, validation errors, a CAPTCHA; else leave it to the caller. */
  private async watchSubmitWindow(page: Page, before: Set<string>): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < SUBMIT_WINDOW_MS) {
      if (await this.confirmationShown(page)) return;
      if (await codePromptOn(page)) return;
      let probe;
      try {
        probe = await probePage(page);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (probe.thanks && !probe.controlsLeft) return;
      const persisted = Date.now() - started >= PERSISTING_ERROR_MS;
      const errors = probe.errors.filter((e) => persisted || !before.has(e));
      if (errors.length > 0)
        throw new SubmissionFailure('form-rejected', {
          errors: errors.map((e) => sanitizeMessage(e)),
        });
      if (probe.frame || (await findCaptchaOn(page))) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async confirmed(page: Page): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if (await this.confirmationShown(page)) return true;
      const probe = await probePage(page).catch(() => null);
      if (probe && probe.thanks && !probe.controlsLeft) return true;
      if (Date.now() - started >= CONFIRM_TIMEOUT_MS) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  codePrompt(page: Page): Promise<boolean> {
    return codePromptOn(page);
  }

  async advanceCode(page: Page): Promise<void> {
    const button = page
      .locator('button:visible, [role="button"]:visible, input[type="submit"]:visible')
      .filter({ hasText: /^\s*(verify|continue|confirm|submit code)/i })
      .filter({ hasNot: page.locator('[data-wma-nav="submit"]') })
      .first();
    if (await button.count()) await button.click({ timeout: 2_000 }).catch(() => {});
  }

  async findCaptcha(page: Page): Promise<CaptchaHandle | null> {
    return (await findCaptchaOn(page)) ?? (await findFrameCaptcha(page));
  }

  notices(page: Page): Promise<FormNotice[]> {
    return readNotices(page);
  }
}
