# Submission form adapters

Code: `apps/worker/src/submission/adapters/`. Tests: `apps/worker/test/submission/adapters.test.ts`
against synthesized fixtures in `apps/worker/test/fixtures/forms/`.

Contract: the `FormAdapter` interface in `apps/worker/src/submission/types.ts`. One adapter per
vendor; `selectAdapter(url)` picks it by hosted-vendor host and returns
`{ ok: false, reason: 'unsupported-ats' }` for everything else without opening a browser.

| Vendor     | Hosts matched                                              | Form page                       |
| ---------- | ---------------------------------------------------------- | ------------------------------- |
| Greenhouse | `boards.greenhouse.io`, `job-boards[.eu].greenhouse.io`    | the posting page itself         |
| Lever      | `jobs.lever.co`, `jobs.eu.lever.co`                        | `<posting>/apply` (added by `load`) |
| Ashby      | `jobs.ashbyhq.com`                                         | `<posting>/application` (added by `load`) |

Only the exact hosts match; look-alike hosts and non-http(s) URLs are unsupported.

## How `fields()` works

A browser-side scan (`scan-script.ts`) walks the question blocks of the form and reports id,
label (required marker stripped), type, required, max length, options and a section hint (the
enclosing section's id, class, heading text, plus the control's name and id). Node-side
`classify.ts` turns that into a classification.

A field is `required` when its label carries the vendor's required marker or any of its controls
is `required` / `aria-required`. The descriptor `id` is the control's `id`, falling back to its
`name`; radio and multi-checkbox groups use the shared `name`. `fields()` reads every question on
the page, including those on hidden steps.

## Classification rules (all vendors)

Evaluated in this order:

1. `self-identification` when the section hint matches EEO, EEOC, self-identif*, voluntary,
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
   unanswerable. The LLM label fallback of design D2 belongs to that step, not to the adapters.

A required field that is a file input other than the resume can never be filled; it surfaces as
`unmapped-field` (below).

## Per-vendor hints

### Greenhouse

- Form `#application_form`; each question is a `.field` (`fieldset.field` with a `legend` for
  radio groups) with `label.field-label`; the required marker is `.asterisk`.
- Sections: `#main_fields` (name, email, phone, resume, cover letter), `#custom_fields`
  (employer questions), `#eeoc_fields` (voluntary self-identification; selects named
  `job_application_gender`, `_hispanic_ethnicity`, `_race`, `_veteran_status`, `_disability_status`).
- Resume input `#resume`; submit `#submit_app`; confirmation `#application_confirmation`.
- Accounts: `#account_form` (`#account_email`, `#account_password`, optional
  `#account_password_confirmation`, `#account_terms`); create `#create_account`, sign in
  `#sign_in`, switch links `#show_signup` / `#show_signin`; error `.error`; after sign-up
  `.verification-sent`.

### Lever

- Form `#application-form`; each question is `li.application-question` with `.application-label`;
  the required marker is `.required`. Ids are mostly absent so the descriptor id is the input
  `name`: `name`, `email`, `phone`, `org`, `urls[LinkedIn]`, `cards[<id>][field<n>]` (employer
  questions), `comments`, and `eeo[gender|race|veteran|disability]` (the `.application-eeo`
  section). The resume input is `#resume-upload-input` (`name="resume"`).
- Submit `#btn-submit`; confirmation `.application-confirmation` or a `/thanks` URL.
- No candidate accounts: `requiresAccount` is always false and `signUp` / `signIn` throw.

### Ashby

- Form `#ashby-application-form`, a sequence of `section.ashby-step[data-step]`; only the current
  step is visible. Questions are `.ashby-application-form-field-entry` with
  `.ashby-application-form-question-title`; required marker
  `.ashby-application-form-question-required`. System fields have ids
  `_systemfield_name`, `_systemfield_email`, `_systemfield_resume`.
- The self-identification step is the section whose heading says Voluntary Self-Identification.
- `fill` walks the steps with Next/Back (Next is blocked while a required text field on the step
  is empty), `submit` goes to the last step first. `attachResume` does not navigate: a file input
  accepts files while its step is hidden. The job attaches the resume before `fill`, because Next
  validates the step's required upload.
- Submit `.ashby-application-form-submit-button`; confirmation
  `.ashby-application-form-success-container`.
- Accounts: `.ashby-auth-form` (`data-mode` sign-up or sign-in), `.ashby-auth-submit`,
  `.ashby-auth-switch`, error `.ashby-auth-error`, after sign-up `.ashby-auth-verify`.

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
Challenge types without a text answer (image grids, checkbox widgets in iframes) are not
recognized and return null.

## Unmapped fields and failure screenshots

`findUnmappedRequired(fields, values)` lists required fields with no value;
`reportUnmappedFields(page, ctx, fields, values)` returns null when nothing is missing, otherwise
`{ reason: 'unmapped-field', fields: [{id, label}], screenshotKey }` after storing a full-page PNG.
`screenshotOnFailure(page, ctx, name)` stores under
`applicationFileKey(tenant, applicationId, 'failure-<name>.png')` and returns the key, or null if
the page cannot be captured.

## Fixtures

Hand-written, vendor-shaped HTML; nothing was downloaded from a vendor. Each vendor folder has
`form.html`, a confirmation page and, for Greenhouse and Ashby, `account.html` (sign-up),
`signin.html` and `check-email.html`. Variants are selected with a query string on `form.html`:
`?captcha` adds a hidden text-and-image challenge revealed by the first submit (answer `7K3Q`);
`?unmapped` adds a required upload no profile can fill. The test account is
`candidate@example.com` / `correct-horse-battery`. Shared behaviour is in `_shared/fixture.js`.
