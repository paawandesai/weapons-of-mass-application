import type { FormAdapter } from '../types';
import { VendorAdapter } from './common';

/**
 * Ashby hosted forms (jobs.ashbyhq.com/<org>/<id>/application). The form is a single-page app and
 * some boards split it into steps; the generic page layer walks the steps with Next/Back.
 */
export const ashbyAdapter: FormAdapter = new VendorAdapter({
  ats: 'ashby',
  hosts: /^jobs\.ashbyhq\.com$/,
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
});
