# Design brief: dashboard, panic search, run view, feedback, prep, negotiation, demo

Purpose: the read side of the system plus a reproducible demo. Read by the user on the board and by the hackathon audience.

Inputs: applications, jobs, companies, runs, run_candidates, interviews, email_threads, outgoing_messages, activity_log, captcha_requests; the approved profile; `tenants.demo`, `jobs.seeded`.

Units: n/a. Times displayed in the user's timezone.

Rules:
1. Board columns are a pure mapping: `pending|applied -> Applied` (pending carries `badge: 'pending'`), `interviewing -> Interviewing`, `offer -> Offer`, `closed -> Closed`. No board table.
2. A user move writes, in one transaction, `applications.status` conditioned on the status the client saw (`from`), a `stage_overrides` row, and a user-actor activity entry `stage_changed`; a mismatch returns 409 with the current status and writes nothing.
3. `isActionable(application)` is `status !== 'closed'`; every agent job that acts on an application (submission retry, follow-up, scheduling offers, booking, prep plan, negotiation) checks it first and logs `skipped_not_actionable`.
4. Agent status writes remain conditional (`applyTransition`); a user move that landed first wins and the agent write is logged as rejected.
5. Card detail returns: job summary, decision rationale, resume reference, form answers, unmet requirements, linked threads (subject, kind, flags; never raw bodies of other tenants), activity entries (cursor-paged), interviews with slots state, prep plan status and text, feedback, negotiation panel data, captcha summary. Cross-tenant id returns 404.
6. Panic search: `ILIKE '%q%'` over company names joined to the user's applications, tenant-scoped, max 20, 2-character minimum.
7. Run view reads `runs` and `run_candidates` only (no jobs rows for skipped candidates); returns candidates since a cursor in rank order with rationale, selection and exclusion reason, never `fit`; the web polls every 5 seconds only while a run is `running`.
8. Feedback: `interviews.feedback` jsonb `{notes, relayed, rating 1..5|null, submitted_at, updated_at}`; create requires non-empty notes or relayed; edit keeps `submitted_at`; user-actor activity entry each time.
9. Prep plan: job `prep-plan` enqueued when an interview is booked (hook in the booking step) and on demand from the card; `prep-plan@1` structured output `{likely_questions[], topics[], company_research, interviewer_background|null}`; public research is the posting plus the company board page text only (no web search); one retry then `failed` with an activity entry; `prep_plan_status` pending|ready|failed.
10. Negotiation: job on transition to `offer` writes `applications.negotiation = {posted_min, posted_max, currency, floor, comparables[], fetched_at, error|null}`; comparables come from a Playwright fetch of the levels.fyi public page for title and location through `comparables-extract@1`; failure logs `comparables_failed` and the panel shows posted range and floor. NO code path in this change sends email; a test asserts no outgoing row or mail job is created by the offer transition.
11. Demo flag: `tenants.demo` is set only by the seed script; no API writes it; a startup check logs an error if more than one tenant is flagged.
12. Simulated recruiter (deviation from the OpenSpec design, decided 2026-11-07): instead of a second Gmail account, demo tenants get a `demo_mailbox` table that implements the same `InboxGmailPort` the real sync uses (list history, list messages, get message, get thread) and the same `GmailSender`/`SentLookup` ports for outgoing mail, so the inbox sync, linking, classification, slot offer, confirm and booking all run the real code against local mail. The simulated recruiter job, for demo tenants and seeded jobs only, writes a three-slot proposal message into `demo_mailbox` within five minutes of `applied` (immediately in tests), with a recruiter display name per seeded company and header `X-WMA-Simulated: 1`; it watches `outgoing_messages` of kind `recruiter_reply` for its thread, and writes an acknowledgement (or an unavailable-slot reply when the accepted time is not one it offered). Calendar for demo tenants is an in-process fake `CalendarPort` that records events. Real tenants never touch any of this: the port factory switches on `tenants.demo`.
13. Demo sign-in (deviation, decided 2026-11-07): `POST /auth/demo` creates a session for the demo user only when `NODE_ENV !== 'production'` AND `DEMO_LOGIN_TOKEN` is set AND the request carries it; otherwise 404. It exists because the fictional persona has no Google account and the e2e needs a session.
14. Seed script `pnpm seed:demo` is idempotent by natural keys: demo tenant (slug `demo`), user `demo@wma.local` with an approved fictional profile (senior/staff SWE, Bay Area, remote ok), twelve seeded companies and jobs across the three vendor shapes pointing at fixture forms served by the worker on `http://127.0.0.1:4310/forms/<vendor>/<id>`, one of them the CAPTCHA variant, and one seeded finished run with candidates. Running it twice leaves identical counts.
15. Playwright e2e (apps/web/e2e) runs against the real API, worker and database with the demo sign-in: board drag to Closed persists and a forced API failure reverts with a toast; card detail shows resume, answers, thread and log; panic search opens the card; run view shows rows for a seeded in-progress run; feedback from the card; prep plan opened from a card; offer panel on an Offer card.

Edge cases: a card moved by the user to Closed while a submission is mid-flight: the submission's next conditional write is rejected and logged. A run view for a user with no runs shows the empty state. Search for 1 character returns 400. Prep plan requested twice while pending is a no-op.

Time: run view "in progress" = `runs.status = running`; demo recruiter delay is a configurable number of seconds (default 0 in tests, 60 in the seeded demo).

Failure handling: per job; prep and negotiation failures never affect the card's status.

Consistency: rule 2's transaction; the demo mailbox is per tenant and tenant-scoped like every other table.

Outputs: routes `GET /api/board`, `POST /api/applications/:id/stage`, `GET /api/applications/:id` (extended), `GET /api/search/companies?q=`, `GET /api/runs/current`, `POST/PUT /api/interviews/:id/feedback`, `POST /api/interviews/:id/prep-plan`, `POST /auth/demo`; worker jobs `prep-plan`, `negotiation`, `simulated-recruiter`; `pnpm seed:demo`; `docs/DEMO.md`; a committed `scripts/demo-rehearsal.sh` that brings up Postgres, migrates, seeds, starts api+worker, runs the e2e and prints the timings.

Tests: one per rule 1..15; tenant isolation on every new endpoint; the offer transition creates no mail; the demo flag cannot be set via API (403 or 404); seed twice equal counts; simulated recruiter sends once for a demo tenant and never for a real tenant or a non-seeded job; the full scheduling scenario (inbox task 7.1) runs on the demo mailbox: applied -> proposal -> slots offered -> POST confirm -> reply -> event -> interviewing -> reminders scheduled, with no outgoing text containing money terms.

Out of scope: interviewer-facing voice feedback, real-time push, learning, a real second Gmail account (documented as the production swap in docs/DEMO.md).
