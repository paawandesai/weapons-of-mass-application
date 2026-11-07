import type { FormAdapter } from '../types';
import { VendorAdapter } from './common';

/**
 * Greenhouse hosted boards (boards.greenhouse.io, job-boards.greenhouse.io, EU variants). Only
 * hints live here; the generic page layer reads and fills the form. Account pages
 * (`#account_form`) are handled for boards that put a candidate account in front.
 */
export const greenhouseAdapter: FormAdapter = new VendorAdapter({
  ats: 'greenhouse',
  hosts: /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/,
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
