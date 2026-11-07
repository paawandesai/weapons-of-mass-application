# Design brief: submission state machine, truthfulness check, CAPTCHA chain

Purpose: turn a PENDING application row into a submitted ATS application with a truthful tailored resume, without ever leaving a half-applied state, and with every step in the activity log. Read by the board, the inbox loop and the user.

Inputs: `applications` row (status pending, `attempt_count`, `run_id`), its `jobs` row (url, ats, title, description, decision facts in `run_candidates.judgment`), approved profile document, vault (`ats_password` secrets), Gmail client for verification and confirmation emails, Playwright browser.

Units: time in UTC timestamptz; waits in seconds: CAPTCHA human hold 900, verification poll 15 with cap 300, confirmation email cap 600, worker poll 5.

Rules (state machine):
1. States: `pending -> applied | pending(reason) | closed(submission-failed)`. The job never creates rows; it loads the row and MUST exit with a logged `duplicate_enqueue` entry and no action if status is not `pending` or another attempt holds the row (`select ... for update skip locked`).
2. Before any browser action the job checks for a prior confirmation (page or Gmail) for this application; if found it moves straight to `applied` with `confirmation_source` and logs `submitted` with `{source, prior: true}`.
3. Step order: `tailor -> account -> fill -> submit -> confirm`. Each step's state change and its activity entry commit in one transaction (`submission-started`, `tailored`, `account-created|account-signed-in`, `filled`, `submitted`, or the pending reason). A crash between steps leaves the last entry as the evidence.
4. Pending reasons are an enum: `tailoring-check-failed`, `unsupported-ats`, `unmapped-field`, `missing-profile-field`, `unanswerable-question`, `verification-timeout`, `credential-rejected`, `captcha-timeout`, `unconfirmed`, `browser-error`. Each sets `pending_reason`, increments `attempt_count`, stores a failure screenshot when a page exists, and logs the reason.
5. Retry: the next daily run re-enqueues pending rows with `attempt_count = 1` once (no re-judging); a second failure sets `closed` with `closed_reason = submission-failed`.
6. Tailoring MUST produce a resume whose extracted employers, titles, degrees and certifications all match the profile after normalization (lowercase, strip punctuation and the suffixes inc, llc, ltd, corp, co, gmbh); any date range outside the profile's range for that employer fails. One regeneration with the failures quoted; second failure -> `tailoring-check-failed`. Skills are not mechanically checked.
7. Every resolved form value is written to `applications.form_answers` (keyed by exact question text) BEFORE `submit()`; self-identification fields are never filled and are recorded as `{skipped: "self-identification"}`.
8. Free-text answers: `{answer, grounded, unanswerable}`; required+unanswerable -> `unanswerable-question`; optional+unanswerable -> blank; `grounded = false` -> one retry quoting the ungrounded claim, then `unanswerable` handling.
9. Accounts: password 24 chars from a 62-char alphabet; written to the vault (kind `ats_password`, ref `<ats>:<company_id>`) and to `ats_credentials` BEFORE the sign-up form submits. Verification: poll Gmail for messages from the ATS or company domain received after sign-up start, every 15 s up to 300 s; follow the first verification link or enter a 6-8 digit code; timeout -> `verification-timeout`. A rejected sign-in sets `rejected_at` and `credential-rejected`; no automatic recreation.
10. Confirmation: vendor marker on the page, else Gmail poll up to 600 s for a message from the ATS/company domain mentioning the job title; either sets `applied_at`, `status = applied`, `confirmation_source = page|email`; neither -> `unconfirmed`.
11. On `applied`, enqueue `follow-up` (singleton key application id, startAfter applied_at + 7 days). Idempotent: a second success never enqueues twice.
12. CAPTCHA: `findCaptcha` -> `captcha_requests` row at stage `agent1`, image stored, `captcha-detected` logged. Stage loops: up to 3 attempts each for `agent1` then `agent2` (different prompts, no shared context); then `human`.
13. Human stage: single-use token, only its sha256 stored, expiry = now + 900 s; email to the user via `sendEmail` with the image inline and a link to `/captcha/<token>`; worker polls the row every 5 s for `human_answer`; wrong answer -> fresh image and token, max 3 human attempts inside the same 900 s window; at expiry the context closes, `expired_at` set, application `captcha-timeout`.
14. `POST /captcha/<token>`: valid token + unexpired + unanswered -> write `human_answer`, 200; reused or expired -> 410 "no longer open", nothing written. `GET` renders the form with the image.
15. One open human-stage request per user: a second CAPTCHA while one is open parks its application with `captcha-timeout` immediately and logs `captcha-parked`.
16. Browser: one browser per worker process, one context per application, closed in `finally`; `submit-application` concurrency 2.
17. The PDF is rendered from `apps/worker/templates/resume.html` with Letter size; page count MUST be 1 or 2 (shrink font one step, then fail `tailoring-check-failed` with detail `too_long`); stored at `tenants/<tenant>/applications/<id>/resume.pdf`.

Edge cases: a posting whose URL is not a hosted vendor form -> `unsupported-ats` without opening a browser. A form with no resume field still attaches nothing and proceeds. An application whose job row was deleted is `closed` with reason `job_missing`. A credential exists but the vault returns `corrupt` -> `credential-rejected`.

Time: all waits are wall-clock with injected clock in tests; the human window is measured from the email send.

Failure handling: per application only; a browser crash is `browser-error`; the worker process must never die because of one application.

Consistency: `form_answers` before submit (rule 7); vault before sign-up submit (rule 9); state and log in one transaction (rule 3).

Outputs: application row fields; `ats_credentials`; `captcha_requests`; file store objects; activity entries; `GET /applications/:id` (detail: resume ref, form answers, unmet requirements, activity, captcha summary with stages and attempts).

Tests: one per rule 1..17 with stubbed adapters, FakeLlm and a fake Gmail; the three vendor fixtures end to end; CAPTCHA chain accept / reject-then-accept / timeout / two concurrent for one user; prior-confirmation path; two consecutive runs over a failing application; 5 queued applications never exceed 2 open contexts.

Out of scope: proxies, fingerprinting, paid solvers, non-vendor-hosted forms, LinkedIn/Indeed applying, learning.
