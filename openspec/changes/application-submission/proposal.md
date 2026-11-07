# Proposal

## Why

The daily run hands over a ranked list of jobs worth applying to, but nothing yet turns a job into a submitted application. This change builds the part of the loop that writes a truthful tailored resume, fills and submits the ATS form on the user's behalf, creates ATS accounts where required, and gets past CAPTCHAs without stalling the run. Without it the product never reaches "Applied", which the hackathon demo depends on.

Implements PRD v1.2 sections 7.4 (resume tailoring), 7.5 (application submission), 7.6 (CAPTCHA escalation chain), 8 (applications, captcha_requests, file store references), 10 (truthful tailoring, voluntary self-identification never filled) and 13 (CAPTCHA acceptance criteria), under assumptions A3 (human CAPTCHA path by email), A4 (ATS accounts use the user's Gmail address) and A12 (one house resume template).

## What Changes

- Generate one tailored resume per application from the approved master profile and the posting, rendered to PDF from a single house template, with a hard rule that nothing absent from the profile is introduced.
- Answer free-text form questions with LLM-generated text grounded in the profile, capped in length, and store every answer with the application so the user can see what was said.
- Fill and submit Ashby, Greenhouse and Lever application forms from the profile, the tailored resume and the generated answers; skip voluntary self-identification sections entirely.
- Create an ATS account with the user's Gmail address and a generated password when the ATS requires one; store the credential in the per-tenant vault; complete email verification by reading the user's Gmail.
- Detect submission confirmation and move the application to APPLIED; store failed or CAPTCHA-parked submissions as PENDING with one retry on the next run.
- Resolve CAPTCHAs through a three-stage chain: a first solving agent (up to 3 attempts), a second independent agent (up to 3 attempts), then the user by email with the challenge image and a reply form, holding the browser session for 15 minutes before parking.
- Write an activity log entry for every step the agent takes on the user's behalf.

## Capabilities

### New Capabilities
- `resume-tailoring`: producing a truthful, posting-specific resume PDF from the master profile for one application.
- `form-answers`: generating and recording answers to free-text application questions from the profile.
- `application-submission`: filling and submitting an ATS application form, confirming the result, and tracking PENDING and APPLIED states with retry.
- `ats-accounts`: creating and storing ATS accounts and completing email verification when an ATS requires an account.
- `captcha-escalation`: resolving CAPTCHA challenges through two automated agents and then the user, with a bounded hold and parking.

### Modified Capabilities
None. This change consumes the top-N hand-off from `daily-run` (job, decision facts, profile) and relies on `tenancy`, `profile`, `activity-log` and `credential-vault` from `mvp-foundation`, without changing their requirements.

## Out of scope

- Job discovery, decision and ranking (`job-discovery-and-decision`).
- Reading recruiter replies, follow-ups, scheduling and the digest (`inbox-and-scheduling`).
- The kanban board and any user interface beyond the CAPTCHA reply page (`dashboard-and-demo`).
- Any ATS other than Ashby, Greenhouse and Lever; LinkedIn or Indeed logged-in applying.
- Multiple resume templates or user-selected layouts.
- Learning from submission outcomes.

## Impact

- New worker jobs in `apps/worker`: tailor, submit, captcha-solve, captcha-await-human.
- New tables and columns in `packages/db`: `applications` gains `resume_pdf_ref`, `form_answers`, `applied_at`; new `ats_credentials` and `captcha_requests` tables; file store references for resume PDFs and CAPTCHA images.
- New prompts in `packages/llm/prompts`: tailor-resume, answer-form-question, solve-captcha (two variants).
- One new authenticated-by-token route in `apps/api` for the human CAPTCHA reply form.
- Gmail read access is exercised for the first time (verification emails); Gmail send is exercised for the CAPTCHA request email.
- Playwright becomes a runtime dependency of the worker, with per-job browser contexts.
