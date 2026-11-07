import type { FormAdapter } from '../types';
import { VendorAdapter } from './common';

/**
 * Greenhouse hosted boards (boards.greenhouse.io, job-boards.greenhouse.io, EU variants).
 * Questions are `.field` blocks inside `form#application_form`; custom questions sit under
 * `#custom_fields`; the voluntary self-identification block is `#eeoc_fields`.
 * Account pages (`#account_form`) are handled for boards that put a candidate account in front.
 */
export const greenhouseAdapter: FormAdapter = new VendorAdapter({
  ats: 'greenhouse',
  hosts: /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/,
  scan: {
    rootSel: '#application_form',
    fieldSel: '.field',
    labelSel: 'label.field-label, legend.field-label',
    requiredMarkSel: '.asterisk',
    controlSel: 'input, select, textarea',
    sectionSel: '#main_fields, #custom_fields, #eeoc_fields',
    ignoreSel: '#captcha-widget, [data-captcha], .captcha-widget',
  },
  formReady: '#application_form',
  resumeInput:
    '#application_form input[type="file"]#resume, #application_form #resume_fieldset input[type="file"]',
  submitButton: '#submit_app',
  confirmation: { selector: '#application_confirmation' },
  account: {
    form: '#account_form',
    email: '#account_email',
    password: '#account_password',
    confirmPassword: '#account_password_confirmation',
    terms: '#account_terms',
    signUpSubmit: '#create_account',
    signInSubmit: '#sign_in',
    toSignUp: '#show_signup',
    toSignIn: '#show_signin',
    error: '#account_form .error',
    verificationSent: '.verification-sent',
  },
});
