# Tasks

## 1. Schema and storage

- [x] 1.1 Add Drizzle migration: `applications` gains `resume_pdf_ref`, `form_answers` (jsonb), `applied_at`, `attempt_count`, `pending_reason`, `confirmation_source`; verify `pnpm db:migrate` applies cleanly and `pnpm db:check` reports no drift
- [x] 1.2 Add `ats_credentials` table (tenant_id, user_id, ats, company_id, username, password_ciphertext, created_at, rejected_at) with a unique index on (user_id, ats, company_id); verify the migration test inserts and rejects a duplicate
- [x] 1.3 Add `captcha_requests` table (tenant_id, application_id, stage, attempts jsonb, image_ref, token_hash, expires_at, human_answer, resolved_by, resolved_at, expired_at); verify the migration test round-trips a row through every stage
- [x] 1.4 Add file store helpers for `tenants/<tenant>/applications/<id>/` (resume.pdf, captcha-<n>.png, failure-<n>.png); verify a unit test writes and reads back each key with tenant scoping enforced

## 2. Resume tailoring

- [x] 2.1 Write `packages/llm/prompts/tailor-resume@1` taking profile, posting and decision facts, returning structured resume content plus `unmet_requirements`; verify a Vitest snapshot test against a fixture profile and posting produces valid JSON with every employer present in the profile
- [x] 2.2 Write `packages/llm/prompts/extract-resume-facts@1` and the truthfulness comparator with suffix/punctuation normalization; verify unit tests cover an invented employer (fails), a reformatted employer name (passes) and a date range outside the profile (fails)
- [x] 2.3 Implement the tailor step: generate, check, regenerate once on failure, mark PENDING `tailoring-check-failed` on second failure; verify an integration test with a stubbed LLM exercises all three outcomes and the activity log entries
- [x] 2.4 Create `apps/worker/templates/resume.html` with print CSS and the Playwright `page.pdf()` renderer with Letter size and a page-count assertion; verify rendering the fixture resume yields a 1–2 page PDF whose first text line is the user's name
- [x] 2.5 Store the PDF in the file store and the reference on the application; verify the application detail endpoint returns the reference and the unmet requirements

## 3. Form field classification and answers

- [x] 3.1 Define `FieldDescriptor` and the rule-based classifier (standard, free-text, self-identification, resume) with an LLM fallback for unrecognized labels; verify unit tests on 30 real label strings from the three vendors classify every self-identification label correctly
- [x] 3.2 Implement standard-field resolution from the profile with the `missing-profile-field` PENDING outcome; verify a unit test with a profile lacking work authorization produces that reason naming the field
- [x] 3.3 Write `packages/llm/prompts/answer-form-question@1` returning `{answer, grounded, unanswerable}` with the max-length constraint; verify a snapshot test on three question types stays within a 500 character cap and marks a certification-number question unanswerable
- [x] 3.4 Implement answer resolution: optional unanswerable → blank, required unanswerable → PENDING `unanswerable-question`, ungrounded → one retry; verify integration tests with a stubbed LLM cover each branch
- [x] 3.5 Persist every resolved value to `applications.form_answers` keyed by question text before submit; verify the detail endpoint lists each question with its exact entered value

## 4. ATS form adapters

- [x] 4.1 Define the `FormAdapter` interface and URL-based selection with the `unsupported-ats` PENDING outcome; verify a unit test routes sample Ashby, Greenhouse, Lever and unknown URLs correctly
- [x] 4.2 Implement the Greenhouse adapter (load, fields, fill, attachResume, submit, confirmed, findCaptcha, requiresAccount) against a saved HTML fixture; verify a Playwright test fills and submits the fixture and detects the confirmation marker
- [x] 4.3 Implement the Lever adapter the same way; verify its fixture test passes
- [x] 4.4 Implement the Ashby adapter the same way, including its multi-step form; verify its fixture test passes
- [x] 4.5 Add the `unmapped-field` outcome with a failure screenshot to the file store; verify a fixture with an unknown required field produces the PENDING reason and a stored screenshot

## 5. ATS accounts

- [x] 5.1 Implement password generation (24 chars) and vault write through the `credential-vault` capability before the sign-up form submits; verify a unit test confirms the ciphertext round-trips and plaintext never appears in logs
- [x] 5.2 Implement sign-up and sign-in flows per adapter where the vendor supports accounts; verify fixture tests for the sign-up page and the sign-in page
- [x] 5.3 Implement Gmail verification polling (sender domain, received-after filter, 15 s interval, 5 min cap) with link follow and code extraction; verify an integration test with a stubbed Gmail API handles link, code and timeout (`verification-timeout`)
- [x] 5.4 Implement credential reuse and the `credential-rejected` flag; verify an integration test applies twice to the same company and signs in the second time, and a rejected login flags the row without creating a new account

## 6. Submission job and state machine

- [x] 6.1 Implement the `submit-application` pg-boss job with singleton key per application, consuming the `jobs` and PENDING `applications` rows that the `daily-run` hand-off already wrote (it never creates them) and logging `submission-started`; verify a duplicate enqueue for the same application id is logged and runs no second attempt
- [x] 6.2 Implement the step sequence (tailor → account → fill → submit → confirm) with per-step activity log entries written in the same transaction as the state change; verify an integration test with a stubbed adapter shows the ordered entries
- [x] 6.3 Implement confirmation detection via page marker or Gmail confirmation email with the 10 minute cap and `unconfirmed` outcome; verify tests for page, email and timeout
- [x] 6.4 Implement the retry policy: PENDING rows retried once on the next run without re-judging, CLOSED `submission-failed` after the second failure, and prior-confirmation check before resubmitting; verify an integration test runs two consecutive runs over a failing application
- [x] 6.5 On submit success, enqueue a `follow-up` pg-boss job keyed by application id with `startAfter = applied_at + 7 days`; the consumer is delivered by `inbox-and-scheduling`, so the job may sit unclaimed until then; verify a test that a second success for the same application does not enqueue twice
- [x] 6.6 Set worker concurrency to 2 for this job with one browser per process and one context per application closed in `finally`; verify a load test of 5 queued applications never has more than 2 contexts open

## 7. CAPTCHA escalation

- [x] 7.1 Implement CAPTCHA detection per adapter and `captcha_requests` creation with the image stored; verify a fixture page with a challenge creates the row at stage `agent1` and logs `captcha-detected`
- [x] 7.2 Write `solve-captcha-a@1` and `solve-captcha-b@1` prompts with structured output and no shared context, and the three-attempt loops per stage; verify integration tests with stubbed outcomes cover solved-on-attempt-2, agent1 exhausted → agent2, agent2 exhausted → human
- [x] 7.3 Implement the human stage: token generation and hashing, 15 minute expiry, email with inline image and link sent via the user's Gmail; verify a test asserts the email content and that the token hash, not the token, is stored
- [x] 7.4 Add `GET/POST /captcha/<token>` in `apps/api` with the reply form, token validation, single use and expiry handling; verify API tests cover valid reply, reused token and expired token ("no longer open", nothing written)
- [x] 7.5 Implement the worker-side wait (poll row every 5 s, enter answer, re-send with fresh image on rejection up to 3 times, timeout at 15 min → `captcha-timeout`); verify an integration test drives accept, reject-then-accept and timeout
- [x] 7.6 Enforce one open human-stage request per user; verify a test with two concurrent CAPTCHAs for one user sends only one email and parks the other
- [x] 7.7 Record resolving stage and per-stage attempt counts on the request and expose them in the application's activity; verify the activity endpoint shows them

## 8. Integration checks

- [x] 8.1 End-to-end test against the three vendor fixtures: hand-off → APPLIED with PDF, form answers, activity trail; verify `pnpm test:e2e` passes for all three
- [x] 8.2 End-to-end CAPTCHA test: stage one and two stubbed to fail, human reply submitted through the API → APPLIED; verify the test passes and the captcha request shows `resolved_by = human`
- [x] 8.3 Document the submission pipeline, adapter interface and CAPTCHA chain in `docs/submission.md`; verify every documented command runs as written

## Workflow follow-up

- Archive the change after review; the archive step creates the five capability specs under `openspec/specs/`.
