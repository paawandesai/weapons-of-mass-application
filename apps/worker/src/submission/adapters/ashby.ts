import type { Page } from 'playwright';
import type { FieldDescriptor, FieldValues } from '../types';
import { VendorAdapter, attachResumeTo, fillScanned, scanFields, type VendorSpec } from './common';
import { toDescriptor } from './classify';

const NEXT = '.ashby-next';
const MAX_STEPS = 12;

const spec: VendorSpec = {
  ats: 'ashby',
  hosts: /^jobs\.ashbyhq\.com$/,
  scan: {
    rootSel: '#ashby-application-form',
    fieldSel: '.ashby-application-form-field-entry',
    labelSel: '.ashby-application-form-question-title',
    requiredMarkSel: '.ashby-application-form-question-required',
    controlSel: 'input, select, textarea',
    sectionSel: '.ashby-step',
    ignoreSel: '#captcha-widget, [data-captcha], .captcha-widget',
  },
  formReady: '#ashby-application-form',
  resumeInput: '#_systemfield_resume',
  submitButton: '.ashby-application-form-submit-button',
  confirmation: { selector: '.ashby-application-form-success-container' },
  account: {
    form: '.ashby-auth-form',
    email: '.ashby-auth-form input[name="email"]',
    password: '.ashby-auth-form input[name="password"]',
    signUpSubmit: '.ashby-auth-form[data-mode="sign-up"] .ashby-auth-submit',
    signInSubmit: '.ashby-auth-form[data-mode="sign-in"] .ashby-auth-submit',
    toSignUp: '.ashby-auth-switch',
    toSignIn: '.ashby-auth-switch',
    error: '.ashby-auth-error',
    verificationSent: '.ashby-auth-verify',
  },
  applyUrl(url) {
    if (/\/application\/?$/.test(url.pathname)) return url.toString();
    const u = new URL(url.toString());
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/application`;
    return u.toString();
  },
};

/**
 * Ashby hosted forms (jobs.ashbyhq.com/<org>/<id>/application). The form is a sequence of steps
 * (`section.ashby-step[data-step]`); only the current step is visible, so fill and submit walk
 * the steps with Next/Back. fields() reads every step, visible or not.
 */
class AshbyAdapter extends VendorAdapter {
  constructor() {
    super(spec);
  }

  private async goToStep(page: Page, step: number): Promise<void> {
    for (let i = 0; i < MAX_STEPS; i++) {
      const target = page.locator(`.ashby-step[data-step="${step}"]`);
      if (await target.isVisible()) return;
      const current = await this.currentStep(page);
      const nav = page.locator(
        `.ashby-step[data-step="${current}"] ${current < step ? NEXT : '.ashby-back'}`,
      );
      await nav.click();
      await page
        .locator(`.ashby-step[data-step="${current < step ? current + 1 : current - 1}"]`)
        .waitFor({ state: 'visible', timeout: 3_000 })
        .catch(() => {
          throw new Error(`Ashby step ${current} did not advance (a required field is empty)`);
        });
    }
    throw new Error(`could not reach Ashby step ${step}`);
  }

  private async currentStep(page: Page): Promise<number> {
    const visible = page.locator('.ashby-step:not([hidden])').first();
    return Number(await visible.getAttribute('data-step'));
  }

  override async fields(page: Page): Promise<FieldDescriptor[]> {
    return (await scanFields(page, spec.scan)).map(toDescriptor);
  }

  override async fill(page: Page, values: FieldValues): Promise<void> {
    const all = await scanFields(page, spec.scan);
    const steps = [...new Set(all.map((f) => f.step ?? 0))].sort((a, b) => a - b);
    for (const step of steps) {
      await this.goToStep(page, step);
      await fillScanned(
        page,
        all.filter((f) => (f.step ?? 0) === step),
        values,
      );
    }
  }

  override async attachResume(page: Page, pdf: { filename: string; bytes: Buffer }): Promise<void> {
    // The upload sits on an earlier step; a file input accepts files while its step is hidden.
    await attachResumeTo(page, spec.resumeInput, pdf);
  }

  override async submit(page: Page): Promise<void> {
    const last = await page.locator('.ashby-step').count();
    if (last > 0) await this.goToStep(page, last - 1);
    await super.submit(page);
  }
}

export const ashbyAdapter = new AshbyAdapter();
