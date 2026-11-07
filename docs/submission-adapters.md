# Submission form adapters

Code: `apps/worker/src/submission/adapters/`. Tests: `apps/worker/test/submission/adapters.test.ts`
(the demo fixtures through the generic path), `generic.test.ts` (real captures and one synthetic
page per control kind) and `generic-job.test.ts`.

Contract: the `FormAdapter` interface in `apps/worker/src/submission/types.ts`. There is one
adapter object per vendor, but all of them are the same class (`VendorAdapter` in `common.ts`)
driven by **hints**; reading, filling and submitting the form is the generic page layer
(`generic.ts`, with the browser-side scripts in `scan-script.ts`). `selectAdapter(url)` picks the
vendor by hosted-vendor host (or, in demo mode, the fixture forms path) and returns
`{ ok: false, reason: 'unsupported-ats' }` for everything else without opening a browser. The
design is in [design/wave5-generic-submitter.md](design/wave5-generic-submitter.md).

| Vendor     | Hosts matched                                           | Form page                                 |
| ---------- | ------------------------------------------------------- | ----------------------------------------- |
| Greenhouse | `boards.greenhouse.io`, `job-boards[.eu].greenhouse.io` | the posting page itself                   |
| Lever      | `jobs.lever.co`, `jobs.eu.lever.co`                     | `<posting>/apply` (added by `load`)       |
| Ashby      | `jobs.ashbyhq.com`                                      | `<posting>/application` (added by `load`) |

Only the exact hosts match; look-alike hosts and non-http(s) URLs are unsupported.

## Vendor hints

`VendorHints` in `common.ts` is all a vendor file may say:

| Hint           | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `ats`, `hosts` | The `AtsId` and the host pattern.                                                          |
| `applyUrl`     | Maps a posting URL to the page that holds the form (Lever, Ashby).                         |
| `confirmation` | The vendor's confirmation marker: a `selector` and optionally a `url` pattern.             |
| `account`      | Candidate account pages (Greenhouse, and Ashby's demo pages); `null` when there are none.  |
| `resumeInput`  | Optional selector overriding the resume file input. No vendor sets it today.               |

There are no scan selectors in vendor files. A redesign of a vendor's form needs no change here.

## How `fields()` works

`scanPage` runs `SCAN_SCRIPT` in the page. It finds the form root, the controls, groups them into
questions and reads label, required flag, options, current value and a context string (nearest
section heading, class names, control name and id). The script stamps each control with
`data-wma-c` so Playwright can act on exactly what was read. Comboboxes are then opened once to
read their options. `classify.ts` turns label, type and context into a classification.

The rules (form root, controls, question boxes, labels, options, required, kinds, verification,
submit button, resume input, confirmation, CAPTCHA detection) are summarised in
[submission.md](submission.md#the-generic-submitter) and numbered in the design brief.

Descriptor `type` for the answers step: text-like inputs and unrecognised controls are `text`;
comboboxes, listboxes and native selects are `select` (a combobox with no readable options is
`text`); Yes/No buttons and radios are `radio` (Yes/No buttons report options `Yes`, `No`); a
checkbox group is `checkbox` with options and a lone checkbox is `checkbox` without; dates are
`date`; uploads are `file`. `hint` is `large-list` for a combobox of more than 60 options (the
options are left out) and `unknown-control` for a control kind the layer does not know.

## Classification rules (all vendors)

Evaluated in this order:

1. `self-identification` when the context matches EEO, EEOC, self-identif\*, voluntary,
   demographic or diversity, or the label names gender, race, ethnicity, Hispanic/Latino, veteran,
   disability, sexual orientation, transgender or LGBTQ. These are never filled, even if a value
   is supplied (design rule 7).
2. `resume` for a file input labelled resume / CV or named so.
3. `standard` when the label matches a profile-backed pattern: first, last and full name, email,
   phone, location/city/country/address, LinkedIn/GitHub/website/portfolio/URL, current company or
   title, work authorization and sponsorship, relocation, notice period, start date, salary,
   how-did-you-hear, pronouns, and consent/privacy checkboxes. Non-resume file inputs are never
   `standard`.
4. Everything else is `free-text`: the answers step resolves it from the profile or marks it
   unanswerable.

A required field that is a file input other than the resume can never be filled; it surfaces as
`unmapped-field` (below).

## Fill, submit and outcomes

- `attachResume` sets the file on the resume input (hidden inputs and drop zones with an input are
  fine). A form with no resume input proceeds; a drop zone with no input is `unmapped-field`
  naming `resume`.
- `fill` fills the questions that have values (never self-identification or uploads), rescans and
  verifies. A required question that did not take its value throws `SubmissionFailure`
  `unmapped-field` with `fields: [{ id, label }]`; the job stores the failure screenshot.
- `submit` finds the submit button in the form root (walking to the last step first on a stepped
  form). A button that stays disabled or `aria-disabled` after the fill is `unmapped-field` with
  `field: 'Submit'`. After the click it waits up to 10 s for the first of: the vendor
  confirmation or a thank-you text with the form gone (returns), validation errors that were not
  there before the click (`form-rejected`, with the sanitized error texts), a CAPTCHA (returns).
  Otherwise it returns and the job waits for the confirmation email (`unconfirmed` on timeout).
- `confirmed` checks the vendor hint, then the thank-you text.
- `notices` returns visible notices; today that is the application limit (`may not apply more
than N times in any D day`), which the job records as `form-notice`.

Steps: a form whose sections carry `data-step` is walked with the visible Next/Back buttons; the
inactive sections' controls are still read by `fields()`.

## Sign-up and sign-in

`requiresAccount(page)` is true when the account form is on the page. `signUp` fills email,
password (and confirmation and terms where present) and submits, resolving once the
"verification sent" page shows; it throws with the page's message if the form shows an error.
Verification itself (Gmail polling) is the accounts module's job. `signIn` switches to the
sign-in form if needed and returns `ok` when the application form appears, `rejected` when the
page shows an error. If neither appears within 10 s it throws, so a slow or changed page is a
`browser-error`, not a false `credential-rejected`.

## CAPTCHA

`findCaptcha` returns a handle for a visible text-and-image challenge widget (`#captcha-widget`,
`.captcha-widget` or `[data-captcha]`): `screenshot()` is the widget region as PNG, `enter(answer)`
fills its text input and presses Verify, `cleared()` is true once the widget is gone or hidden.

Otherwise it looks for an iframe challenge: an `iframe[src*=hcaptcha]` or `iframe[src*=recaptcha]`
that is visible with a size (the invisible reCAPTCHA badge does not count) or a visible
`[data-sitekey]` box. That handle has `challenge: 'frame'`: `screenshot()` is the full page,
`enter` does nothing (the frame is cross-origin) and `cleared()` is true once the frame is gone.
The job sends frame challenges straight to the human stage.

## Unmapped fields and failure screenshots

`findUnmappedRequired(fields, values)` lists required fields with no value;
`reportUnmappedFields(page, ctx, fields, values)` returns null when nothing is missing, otherwise
`{ reason: 'unmapped-field', fields: [{id, label}], screenshotKey }` after storing a full-page PNG.
`screenshotOnFailure(page, ctx, name)` stores under
`applicationFileKey(tenant, applicationId, 'failure-<name>.png')` and returns the key, or null if
the page cannot be captured. The job's own failure path stores a full-page screenshot for every
park.

## Fixtures

- `forms/{greenhouse,lever,ashby}`: hand-written, vendor-shaped demo forms served by the demo
  forms server; nothing was downloaded from a vendor. Each has `form.html`, a confirmation page
  and, for Greenhouse and Ashby, `account.html`, `signin.html` and `check-email.html`. Query
  variants on `form.html`: `?captcha` adds a hidden text-and-image challenge revealed by the first
  submit (answer `7K3Q`); `?unmapped` adds a required upload no profile can fill. The test account
  is `candidate@example.com` / `correct-horse-battery`. Shared behaviour is in `_shared/fixture.js`.
- `forms/real`: captures of today's Greenhouse job-boards (Anthropic), Ashby (OpenAI) and Lever
  (Palantir) pages: rendered HTML with scripts, styles, iframes and SVG removed, plus Playwright
  aria snapshots. `lever.html` and `lever.aria.yml` were shrunk: the 3,300-school dropdown keeps its
  first 25 schools and "Other - School Not Listed", and the hidden card-definition JSON values
  (about 900 KB) are replaced by `{}`. They are static, so a react-select menu cannot open and
  Greenhouse comboboxes are scanned as `text` there.
- `forms/generic`: one small page per control kind (portal combobox, Yes/No buttons, autocomplete,
  date picker, international phone widget, drop zone), required-detection cases, a disabled
  submit, a validation error, confirmation by text and by URL, an iframe challenge and a badge-only page.
