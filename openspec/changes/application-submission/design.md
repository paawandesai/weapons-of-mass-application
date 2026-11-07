# Design

## Context

See proposal.md for motivation. This change sits between `daily-run` (which hands over the day's top-N jobs with decision facts and the approved profile) and `inbox-and-scheduling` (which reads what happens after submission). It is the first part of the system to drive a real browser, call Gmail, and send email, so it carries most of the runtime risk.

Constraints that shape the approach:

- One droplet, Postgres, pg-boss for the queue, Playwright for both forms and PDF rendering. No Redis, no separate browser farm.
- Three ATS vendors only. Their hosted forms are structurally stable per vendor but vary per company (custom questions, optional sections, account walls).
- The human CAPTCHA path is email plus a reply form (A3), so a browser session must stay open for up to 15 minutes while a worker waits on an HTTP request handled by a different process.
- The never-invent rule is a product guardrail, not a nice-to-have; it needs a mechanical check, not just a prompt instruction.

## Goals / Non-Goals

**Goals:**
- A submission job that is idempotent per application, crash-safe (a killed worker leaves a PENDING row, never a half-applied state), and fully traced in the activity log.
- Per-vendor form adapters behind one interface so adding a fourth ATS later is one file.
- CAPTCHA handling that never blocks the rest of the run: one held session at a time per user, bounded by a wall clock.
- A truthfulness check that is independent of the model that wrote the resume.

**Non-Goals:**
- Solving every CAPTCHA type. Image and text challenges only; an unrecognized challenge type goes straight to the human stage.
- Browser fingerprint management or proxy rotation.
- Supporting ATS forms embedded in company-owned pages rather than the vendor's hosted URL.

## Decisions

### D1. One pg-boss job per application, with an explicit state machine
`submit-application` is a single job keyed by `application_id` (singleton key). The `jobs` row and the PENDING `applications` row (with `run_id`) are written by the `daily-run` hand-off in its own transaction before the job is enqueued; this job only moves the existing row through `pending → applied | pending(reason)`. On success it enqueues a `follow-up` job for `inbox-and-scheduling` to consume. Each step writes its activity log entry inside the same transaction as its state change, so a crash between steps is visible as the last logged step. Retry policy is in the row (`attempt_count`), not in pg-boss retries, because the retry must wait for the next daily run and must skip re-judging.

Alternative considered: one job per step (tailor, fill, submit). Rejected; it multiplies queue state and makes the "hold the browser for the human" step impossible without a separate session store.

### D2. Per-vendor form adapters behind one interface
`FormAdapter { detect(url), load(page), requiresAccount(page), fields(page): FieldDescriptor[], fill(page, values), attachResume(page, pdf), submit(page), confirmed(page): boolean, findCaptcha(page): CaptchaHandle | null }`. Three implementations (`ashby`, `greenhouse`, `lever`) selected by URL pattern. Field descriptors carry the question text, input type, required flag, max length and a classification (`standard`, `free-text`, `self-identification`, `resume`). Classification is rule-based on label text and vendor section ids, with the LLM used only to classify labels the rules do not recognize.

Alternative considered: a single generic DOM-driven filler. Rejected; the three vendors differ enough in section structure, file inputs and confirmation pages that a generic filler would carry three sets of special cases anyway.

### D3. Value resolution order: profile → generated answer → blank
Standard fields come from `profile.standard_answers` and identity sections without a model call. Free-text fields go to the `answer-form-question` prompt with the profile, the posting and the field's max length as structured input, returning `{answer, grounded: boolean, unanswerable: boolean}`; `grounded: false` is treated as a failed generation and retried once with the offending claim quoted back. Self-identification fields are never passed to the model. Every resolved value is written to `applications.form_answers` (jsonb, keyed by question text) before `submit()` is called, so a crash after submit still leaves the record of what was entered.

### D4. Truthfulness check is a second, independent extraction
After `tailor-resume` returns, a separate low-cost call extracts the structured facts (employers, titles, date ranges, degrees, certifications) from the generated resume text and the check compares them against the profile with normalized string matching. Any unmatched employer, title, degree or certification fails the check; a date range outside the profile's range for that employer fails it. One regeneration is attempted with the failures listed; a second failure marks the application PENDING with reason `tailoring-check-failed`. Skills are not checked mechanically (synonyms make that unreliable) but the prompt forbids adding them and the posting's unmet skills are recorded on the application.

### D5. PDF rendering reuses Playwright
The house template is an HTML file with CSS print rules in `apps/worker/templates/resume.html`. The worker renders it with the tailored content, loads it in a headless page, and calls `page.pdf()` with Letter size and a two-page assertion (page count read back with a PDF parser). This avoids a second rendering dependency and keeps fonts consistent. PDFs go to the file store under `tenants/<tenant>/applications/<id>/resume.pdf`; the application stores the key.

### D6. Browser isolation: one context per application, one browser per worker process
Each job opens a fresh `BrowserContext` (cookies, storage isolated per application) on a shared browser instance in the worker process. Contexts are closed in a `finally`. Worker concurrency is capped at 2 for `submit-application` to keep memory predictable on one droplet. Screenshots on failure go to the file store under the application's folder for diagnosis.

### D7. ATS accounts and verification
`requiresAccount(page)` triggers the account flow: a generated 24-character password, sign-up with the user's Gmail address, credential written to `ats_credentials` through the `credential-vault` capability's encrypt call before the sign-up form is submitted (so a crash after submit does not lose the password). Verification polls the user's Gmail (via the existing OAuth token) for messages from the ATS domain received after sign-up, every 15 seconds for up to 5 minutes, follows the first verification link or extracts a 6-to-8 digit code. Sign-in for a reused credential uses the same adapter's `signIn(page, credential)`. A rejected credential flags the row (`rejected_at`) and the application goes PENDING; account recreation is deliberately manual.

### D8. CAPTCHA chain and the human hand-off
`findCaptcha(page)` returns a handle with a screenshot of the challenge region and an input locator. Stage one and stage two are two prompts (`solve-captcha-a`, `solve-captcha-b`) with different instructions and no shared history, each given the image and asked for structured output `{answer}`; the adapter enters the answer and checks whether the challenge is cleared. Rejections increment `captcha_requests.attempts[stage]`.

For the human stage the worker:
1. Writes `captcha_requests.stage = 'human'`, generates a single-use token, stores its hash with an expiry 15 minutes out, uploads the current image, and sends the email (through the user's own Gmail send scope, to the user) with the image inline and a link to `/captcha/<token>`.
2. Keeps the Playwright context open and polls the `captcha_requests` row every 5 seconds for `human_answer`.
3. The API route `POST /captcha/<token>` validates the token hash and expiry, writes `human_answer`, and returns a confirmation page. A second submission or an expired token returns "no longer open" and writes nothing.
4. When the worker sees `human_answer` it enters it; on acceptance it marks the request resolved by `human`; on rejection it re-sends the email with a fresh image and token (counted as a human attempt, max 3 within the same 15-minute window).
5. At 15 minutes the worker closes the context, marks the request `expired`, and sets the application PENDING with reason `captcha-timeout`.

Polling Postgres rather than a push channel keeps the hand-off inside the one store we already have. Only one human-stage request may be open per user at a time; a second CAPTCHA for the same user while one is open goes straight to timeout handling so two 15-minute holds never run in parallel.

### D9. Confirmation detection
`confirmed(page)` checks the vendor's known confirmation page markers. If absent, the worker waits up to 10 minutes polling Gmail for a confirmation email from the ATS or company domain mentioning the job title. Either source sets `applied_at`, `status = applied`, and logs `submitted` with `source: page | email`. Neither source leaves PENDING with reason `unconfirmed`.

## Risks / Trade-offs

- [Vendor form changes break an adapter] → Each adapter has a fixture-based test against a saved copy of a real form; failures surface as `unmapped-field` PENDING rows with a screenshot rather than wrong submissions.
- [Human CAPTCHA hold ties up a worker slot for 15 minutes] → Concurrency 2 with one human hold per user; the second slot keeps the rest of the run moving. Acceptable for the MVP's daily volume.
- [Truthfulness check has false positives on reformatted names (e.g. "Google" vs "Google LLC")] → Normalization strips suffixes and punctuation; a false positive costs one regeneration, not a wrong submission.
- [Gmail polling for verification and confirmation emails may read the wrong thread] → Filter by received-after timestamp and sender domain; log the message id used so it is auditable.
- [Two senders of email would bypass the content guard] → All outgoing mail, including the CAPTCHA request, goes through one `sendEmail` function in packages/shared/mail. This change creates it with Gmail send only; `inbox-and-scheduling` adds the compensation-content guard inside the same function, so nothing else ever holds a Gmail client.
- [Sending the CAPTCHA email from the user's own Gmail to themselves looks odd] → Acceptable for the MVP; it avoids a transactional mail provider. The subject line names the company and the app.
- [Worker crash mid-submission leaves an ATS-side submitted application with a PENDING row] → Confirmation email polling on the retry run checks for a prior confirmation before resubmitting; if found, the row is moved to APPLIED without a second submit.
- [Automated CAPTCHA solving may be unreliable] → The chain is designed so automated failure costs only time; the acceptance criterion is that the human path works, not that the agents succeed.

## Migration Plan

New tables and columns only (`ats_credentials`, `captcha_requests`, new columns on `applications`); one Drizzle migration. No data to migrate. Rollback is dropping the migration; no other capability depends on these columns yet.

## Open Questions

- Whether a per-tenant "CAPTCHA provider" setting should later allow a paid solver as stage two. Can be added as a stage implementation without changing the specs.
- Exact two-page enforcement for very long profiles (truncate oldest roles vs. shrink font). The template starts with a font-shrink step; truncation can be added later without spec change.
