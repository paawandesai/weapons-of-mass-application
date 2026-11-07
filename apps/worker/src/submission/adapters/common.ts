import type { Locator, Page } from 'playwright';
import { applicationFileKey } from '@wma/db';
import type { AtsId } from '@wma/shared';
import type {
  Account,
  CaptchaHandle,
  Credential,
  FieldDescriptor,
  FieldValues,
  FormAdapter,
  SignInOutcome,
  SubmissionContext,
} from '../types';
import { toDescriptor, toScanned, type RawField, type ScannedField } from './classify';
import { SCAN_SCRIPT } from './scan-script';

export interface ScanConfig {
  /** The application form (or any ancestor of its questions). */
  rootSel: string;
  /** One element per question. */
  fieldSel: string;
  /** The question text inside a field element. */
  labelSel: string;
  /** Marker inside the label for required questions (removed from the label text). */
  requiredMarkSel: string;
  controlSel: string;
  /** Ancestor whose id, class and heading identify a section (self-identification etc.). */
  sectionSel: string;
  /** Controls inside these are not form questions (CAPTCHA widget, account forms). */
  ignoreSel: string;
}

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

export interface VendorSpec {
  ats: AtsId;
  hosts: RegExp;
  scan: ScanConfig;
  /** Present once the application form is on the page. */
  formReady: string;
  resumeInput: string;
  submitButton: string;
  confirmation: { selector: string; url?: RegExp };
  account: AccountSpec | null;
  /** Maps a posting URL to the page that holds the form. */
  applyUrl?(url: URL): string;
}

export const CAPTCHA_SELECTOR = '[data-captcha], #captcha-widget, .captcha-widget';

const LOAD_TIMEOUT_MS = 20_000;
const CONFIRM_TIMEOUT_MS = 5_000;
const SETTLE_TIMEOUT_MS = 4_000;
const SIGN_IN_TIMEOUT_MS = 10_000;

const attr = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

export async function scanFields(page: Page, cfg: ScanConfig): Promise<ScannedField[]> {
  const raw = (await page.evaluate(`(${SCAN_SCRIPT})(${JSON.stringify(cfg)})`)) as RawField[];
  return raw.map(toScanned);
}

function control(page: Page, f: ScannedField): Locator {
  const id = attr(f.id);
  if (f.type === 'radio' || (f.type === 'checkbox' && f.options)) {
    return page.locator(`input[name="${id}"]`);
  }
  return page.locator(`[id="${id}"], [name="${id}"]`).first();
}

function optionLabel(page: Page, f: ScannedField, text: string): Locator {
  const wanted = new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`, 'i');
  return page
    .locator(`label:has(input[name="${attr(f.id)}"])`)
    .filter({ hasText: wanted })
    .first();
}

async function fillOne(page: Page, f: ScannedField, value: string | boolean | string[]) {
  const loc = control(page, f);
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  switch (f.type) {
    case 'select':
      try {
        await loc.selectOption({ label: text }, { timeout: 3_000 });
      } catch {
        await loc.selectOption({ value: text }, { timeout: 3_000 });
      }
      return;
    case 'radio': {
      const byLabel = optionLabel(page, f, text);
      if (await byLabel.count()) await byLabel.check();
      else
        await page
          .locator(`input[name="${attr(f.id)}"][value="${attr(text)}"]`)
          .first()
          .check();
      return;
    }
    case 'checkbox': {
      if (!f.options) {
        await loc.setChecked(value === true || value === 'true' || value === 'yes');
        return;
      }
      const chosen = Array.isArray(value) ? value : [text];
      for (const option of f.options) {
        const box = optionLabel(page, f, option).locator('input');
        await box.setChecked(chosen.some((c) => c.toLowerCase() === option.toLowerCase()));
      }
      return;
    }
    case 'file':
      return; // only the resume input is ever filled, by attachResume
    default:
      await loc.fill(text);
  }
}

/**
 * Fills the given scanned fields. Self-identification and file fields are never touched
 * (design rule 7), whatever `values` contains.
 */
export async function fillScanned(
  page: Page,
  fields: ScannedField[],
  values: FieldValues,
): Promise<void> {
  for (const f of fields) {
    if (f.classification === 'self-identification' || f.type === 'file') continue;
    const value = values[f.id];
    if (value === undefined) continue;
    await fillOne(page, f, value);
  }
}

export async function attachResumeTo(
  page: Page,
  selector: string,
  pdf: { filename: string; bytes: Buffer },
): Promise<void> {
  const input = page.locator(selector).first();
  if ((await input.count()) === 0) return; // a form with no resume field proceeds without one
  await input.setInputFiles({ name: pdf.filename, mimeType: 'application/pdf', buffer: pdf.bytes });
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

/** Wait for whichever comes first after a submit click: confirmation, CAPTCHA, or a quiet page. */
async function settle(page: Page, spec: VendorSpec): Promise<void> {
  await Promise.race([
    page
      .waitForSelector(spec.confirmation.selector, { timeout: SETTLE_TIMEOUT_MS })
      .catch(() => null),
    page
      .waitForSelector(CAPTCHA_SELECTOR, { state: 'visible', timeout: SETTLE_TIMEOUT_MS })
      .catch(() => null),
  ]);
}

/** Shared behaviour; a vendor supplies its selectors and overrides what its form does differently. */
export class VendorAdapter implements FormAdapter {
  readonly ats: AtsId;

  constructor(protected readonly spec: VendorSpec) {
    this.ats = spec.ats;
  }

  detect(url: string): boolean {
    return hostMatches(url, this.spec.hosts);
  }

  async load(page: Page, url: string): Promise<void> {
    let target = url;
    try {
      const u = new URL(url);
      if (this.detect(url) && this.spec.applyUrl) target = this.spec.applyUrl(u);
    } catch {
      // not a URL we can rewrite; navigate as given
    }
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS });
    const ready = [this.spec.formReady, this.spec.account?.form].filter(Boolean).join(', ');
    await page.locator(ready).first().waitFor({ state: 'visible', timeout: LOAD_TIMEOUT_MS });
  }

  async requiresAccount(page: Page): Promise<boolean> {
    const account = this.spec.account;
    if (!account) return false;
    return (await page.locator(account.form).count()) > 0;
  }

  protected account(): AccountSpec {
    if (!this.spec.account) throw new Error(`${this.ats} forms do not use candidate accounts`);
    return this.spec.account;
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
    return Promise.race([
      page
        .locator(a.error)
        .first()
        .waitFor({ state: 'visible', timeout: SIGN_IN_TIMEOUT_MS })
        .then((): SignInOutcome => 'rejected'),
      page
        .locator(this.spec.formReady)
        .first()
        .waitFor({ state: 'visible', timeout: SIGN_IN_TIMEOUT_MS })
        .then((): SignInOutcome => 'ok'),
    ]);
  }

  async fields(page: Page): Promise<FieldDescriptor[]> {
    return (await scanFields(page, this.spec.scan)).map(toDescriptor);
  }

  async fill(page: Page, values: FieldValues): Promise<void> {
    await fillScanned(page, await scanFields(page, this.spec.scan), values);
  }

  async attachResume(page: Page, pdf: { filename: string; bytes: Buffer }): Promise<void> {
    await attachResumeTo(page, this.spec.resumeInput, pdf);
  }

  async submit(page: Page): Promise<void> {
    await page.locator(this.spec.submitButton).first().click();
    await settle(page, this.spec);
  }

  async confirmed(page: Page): Promise<boolean> {
    const { selector, url } = this.spec.confirmation;
    if (url?.test(page.url())) return true;
    return page
      .locator(selector)
      .first()
      .waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
  }

  findCaptcha(page: Page): Promise<CaptchaHandle | null> {
    return findCaptchaOn(page);
  }
}
