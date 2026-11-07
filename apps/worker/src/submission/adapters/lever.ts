import type { FormAdapter } from '../types';
import { VendorAdapter } from './common';

/**
 * Lever hosted postings (jobs.lever.co, jobs.eu.lever.co). The form lives at `<posting>/apply`.
 * Lever has no candidate accounts.
 */
export const leverAdapter: FormAdapter = new VendorAdapter({
  ats: 'lever',
  hosts: /^jobs(?:\.eu)?\.lever\.co$/,
  confirmation: { selector: '.application-confirmation', url: /\/thanks(?:[/?#]|$)/ },
  account: null,
  applyUrl(url) {
    if (/\/apply\/?$/.test(url.pathname)) return url.toString();
    const u = new URL(url.toString());
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/apply`;
    return u.toString();
  },
});
