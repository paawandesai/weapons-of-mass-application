# Application submission

How a pending application becomes a submitted one: the job, its states, ATS accounts, the CAPTCHA chain and the HTTP surface. The rules are numbered as in [docs/design/wave2-submission.md](design/wave2-submission.md). The form adapters are described in [submission-adapters.md](submission-adapters.md).

## Pipeline

The daily run writes the `jobs` and `applications` rows (status `pending`) and enqueues `submit-application` with the application id as singleton key. The consumer is `apps/worker/src/jobs/submit-application.ts`; the attempt itself is `runSubmission` in `apps/worker/src/submission/job.ts`.

| Step | Activity entry | What it does |
|---|---|---|
| claim | `submission-started` | Per-application advisory lock for the whole attempt, then `for update skip locked` on the row. A row that is not `pending`, or that another attempt holds, logs `duplicate_enqueue` and nothing else happens. |
| adapter | `unsupported-ats` | The posting URL must belong to an Ashby, Greenhouse or Lever board. Decided before any browser is opened. |
| prior check | `submitted` with `prior: true` | On a retry, Gmail is searched for a confirmation that arrived after the first attempt started. If an earlier attempt got as far as `submitting`, the vendor page is loaded and checked for its confirmation marker, and the confirmation email gets the rest of its 600 s window, before anything is filled or submitted again. Either one moves the row straight to `applied`. A confirmation email counts only when its parsed sender is the company's own domain, or the ATS and the message names the company, and it mentions the job title. |
| tailor | `tailored` | Truthful resume rendered to `tenants/<tenant>/applications/<id>/resume.pdf`; the reference and the unmet requirements go on the row. |
| account | `account-created` or `account-signed-in`, `account-verified` | Only when the form requires an account (see below). |
| fill | `filled` | The resume is attached first, then the form is filled. Every resolved value is written to `applications.form_answers`, keyed by question text, in the same transaction as the `filled` entry and before `submit`. Self-identification fields are never filled and are recorded as `{"skipped": "self-identification"}`. Yes/No facts (sponsorship, authorization, and relocation willingness questions, which come from the survey's willing-to-relocate answer; other relocation questions, such as assistance, go to the model) map onto the field's Yes/No options by meaning, and "authorized to work" is only answered Yes for a place the profile's work authorization covers. Consent acknowledgements on checkbox, radio and select fields (privacy policy, terms, data processing, accuracy of the application) are answered Yes by rule and recorded in `form_answers` like any other answer. Grouped checkboxes take the chosen option strings. Questions the profile cannot answer by rule go to the model, which sees identity, work history, projects, skills, education, preferences and the non-financial survey answers (relocation, career direction, work-life balance); never the salary floor or family constraints. |
| submit | `submitting`, `captcha-*` | A CAPTCHA before or after the click goes through the chain below. |
| confirm | `submitted` | The vendor's confirmation marker on the page, else a Gmail poll (every 15 s, up to 600 s) for a message from the ATS or company that mentions the job title. |

Each state change and its activity entry commit in one transaction, so a crash leaves the last entry as the evidence. One browser runs per worker process; each application gets its own context, closed in `finally`. At most two applications run at once per process.

## States and retries

`pending -> applied | pending(reason) | closed(submission-failed)`.

Pending reasons: `tailoring-check-failed`, `unsupported-ats`, `unmapped-field`, `missing-profile-field`, `unanswerable-question`, `verification-timeout`, `credential-rejected`, `captcha-timeout`, `unconfirmed`, `browser-error`. A failure sets the reason, increments `attempt_count`, stores `failure-<n>.png` when a page was open and logs the reason as the entry's action. The next daily run re-enqueues the row once without re-judging; a second failure closes it with `closed_reason = submission-failed`. `unsupported-ats` is never retried and never closed by the count. A deleted job closes the row with `job_missing`.

On `applied`, a `follow-up` job is enqueued with the application id as the job id and `startAfter = applied_at + 7 days`, and `applications.follow_up_enqueued_at` is set. An applied row with that column null is the outbox record: `reconcileFollowUps` (worker startup, then hourly) enqueues it, and the singleton key makes a repeat a no-op. Its consumer belongs to the inbox work.

Failure details in the activity log hold an allowlisted error category and a sanitized message (everything from the first mention of a password or token is dropped, URLs and long token-like runs are replaced). Raw browser text is never stored. A failure with no recorded outcome (database outage, profile load) is rethrown so pg-boss retries the job with the options in `SUBMIT_QUEUE_OPTIONS`.

## ATS accounts

When `requiresAccount` is true the job looks up `ats_credentials` for the user, ATS and company. The whole operation runs under an advisory lock on (user, ATS, company). A `verified` credential signs in; a rejected sign-in (or a vault entry that is missing or corrupt) sets `rejected_at` and parks the application as `credential-rejected`. Accounts are never recreated automatically. Without a credential, a 24-character password is generated, written to the vault (`ats_password`, reference `<ats>:<company_id>`) and to `ats_credentials` with status `registering`, and only then is the sign-up submitted. A credential still `registering` (the worker died mid-sign-up) is resumed with its vaulted password: the sign-up is submitted again, and if the vendor refuses it a sign-in with the same password completes it; a refused sign-in there is not final. If the page still asks for an account afterwards, Gmail is polled every 15 s for up to 300 s for a verification link or a 6-8 digit code from mail received after that credential's registration started and tied to the company (same rule as confirmation mail); no mail in time is `verification-timeout`. Success marks the credential `verified`. Passwords never reach logs, activity entries or the application row.

## CAPTCHA chain

`findCaptcha` returns a handle; the job stores the image, inserts a `captcha_requests` row at stage `agent1` and logs `captcha-detected`.

1. `agent1`: up to three attempts with the `solve-captcha-a` prompt.
2. `agent2`: up to three attempts with the `solve-captcha-b` prompt (different instructions, no shared history).
3. `human`: one open request per user (a second one is parked at once with `captcha-parked` and the application is `captcha-timeout`). A single-use token is generated; only its sha256 is stored. The user gets an email through `sendEmail` with the image inline and a link to `${WEB_ORIGIN}/captcha/<token>`. The worker polls the row every 5 s. A wrong answer sends a fresh image and token (three human attempts at most) inside the same 900 s window, measured from the first email. At the end of the window the context closes, `expired_at` is set and the application is `captcha-timeout`.

The row records the resolving stage and the attempt count per stage; both appear in the application detail.

## HTTP

| Route | Purpose |
|---|---|
| `GET /api/applications?status=pending,applied` | The signed-in user's applications, newest first. |
| `GET /api/applications/:id` | Detail: job, resume reference, form answers (question, status, value), unmet requirements, activity, CAPTCHA summary with stage and attempts. |
| `GET /captcha/:token` | The reply form with the challenge image. Public: the token is the credential. |
| `POST /captcha/:token` | Stores the reply when the request is open (unanswered, unresolved, unexpired). Otherwise 410 "no longer open" and nothing is written. |

## Configuration

`WEB_ORIGIN` (links in the CAPTCHA email), `FILE_STORE_DIR` (images, resumes, screenshots), `VAULT_MASTER_KEY`, `ANTHROPIC_API_KEY`, and the user's Google connection with Gmail read and send access.

## Tests

```bash
scripts/db-test-reset.sh
pnpm -F @wma/worker test
pnpm -F @wma/api test
pnpm -F @wma/worker exec vitest run test/submission/e2e.test.ts
```

The last command runs the three vendor forms end to end against the saved fixtures (it needs Playwright's Chromium). The CAPTCHA round trip through the reply page is `apps/api/test/captcha-e2e.test.ts`.
