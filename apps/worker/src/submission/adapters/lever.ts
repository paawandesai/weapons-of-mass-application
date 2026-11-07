import type { FormAdapter } from '../types';
import { VendorAdapter } from './common';

/**
 * Lever hosted postings (jobs.lever.co, jobs.eu.lever.co). The form lives at `<posting>/apply`:
 * `li.application-question` blocks with an `.application-label`, inputs named `name`, `email`,
 * `urls[...]`, `cards[...]` (custom questions) and `eeo[...]` (voluntary self-identification).
 * Lever has no candidate accounts.
 */
export const leverAdapter: FormAdapter = new VendorAdapter({
  ats: 'lever',
  hosts: /^jobs(?:\.eu)?\.lever\.co$/,
  scan: {
    rootSel: '#application-form',
    fieldSel: 'li.application-question',
    labelSel: '.application-label',
    requiredMarkSel: '.required',
    controlSel: 'input, select, textarea',
    sectionSel: '.application-section',
    ignoreSel: '#captcha-widget, [data-captcha], .captcha-widget',
  },
  formReady: '#application-form',
  resumeInput: '#application-form input[name="resume"]',
  submitButton: '#btn-submit',
  confirmation: { selector: '.application-confirmation', url: /\/thanks(?:[/?#]|$)/ },
  account: null,
  applyUrl(url) {
    if (/\/apply\/?$/.test(url.pathname)) return url.toString();
    const u = new URL(url.toString());
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/apply`;
    return u.toString();
  },
});
