# Tasks

## 1. Schema and scoping

- [x] 1.1 Add migrations for `tenants.demo`, `jobs.seeded`, `stage_overrides`, `interviews.feedback`, `interviews.prep_plan`, `interviews.prep_plan_status`, `applications.negotiation`; verify `pnpm db:migrate` applies cleanly on an empty database and `pnpm db:migrate` again is a no-op
- [x] 1.2 Add the `forTenant(tenantId)` repository wrapper in packages/db and the `isActionable(application)` predicate in packages/shared; verify unit tests show a query without tenant scope is rejected and a closed application is not actionable
- [x] 1.3 Add a startup assertion that logs an error when more than one tenant has `demo = true`; verify a test database with two flagged tenants produces the log line

## 2. Kanban dashboard

- [x] 2.1 Implement the tenant-scoped board endpoint returning applications grouped by column with the PENDING badge flag; verify an API test with applications in all five statuses returns four columns and the pending one flagged inside Applied
- [x] 2.2 Implement the card detail endpoint (resume reference, form answers, thread, activity log, prep plan); verify an API test returns all sections and a cross-tenant id returns 404
- [x] 2.3 Implement the stage-change endpoint that updates status, writes `stage_overrides` and a user-actor activity_log entry; verify an API test moving Applied to Closed shows all three writes and a failed write leaves status unchanged
- [x] 2.4 Build the board page in apps/web with four columns, card summary fields and drag-and-drop calling the stage-change endpoint with optimistic revert on error; verify a Playwright e2e drags a card to Closed and sees it there after reload, and a forced API failure returns the card to its column with an error toast
- [x] 2.5 Build the card detail drawer; verify an e2e opens a submitted application and sees resume, answers, thread and log, and a card without an interview shows the no-plan message
- [x] 2.6 Document the board columns and badge semantics in docs/ARCHITECTURE.md under a Dashboard heading; verify the section matches the status mapping in code

## 3. Panic search

- [x] 3.1 Implement the tenant-scoped company search endpoint with case-insensitive partial matching; verify an API test matches "acm" to Acme Robotics and returns nothing for another tenant's company
- [x] 3.2 Add the search bar and results list to the board, selecting a result opens the card and highlights it; verify an e2e types a partial company name, selects the result and sees the detail open with the card highlighted

## 4. Run view

- [x] 4.1 Implement the run endpoint returning the in-progress or latest run with counts and candidates since a cursor, tenant-scoped; verify an API test with a seeded run returns candidates in rank order with verdict and rationale, and another tenant's run is not visible
- [x] 4.2 Add the nightly pg-boss job that deletes runs older than seven days; verify a test with an eight-day-old run removes it and its candidates and leaves a two-day-old run
- [x] 4.3 Build the run view page polling every five seconds while a run is running; verify an e2e against a seeded in-progress run shows rows appearing and the no-run message for a fresh user
- [x] 4.4 Add an integration test asserting that after a run with skipped candidates no jobs or applications rows exist for them; verify the test passes

## 5. Interview feedback

- [x] 5.1 Implement feedback create and update endpoints writing `interviews.feedback` and a user-actor activity_log entry, rejecting empty submissions; verify API tests for submit, edit keeping submitted_at, and empty rejection
- [x] 5.2 Build the feedback form on the card and the deep link used by reminders; verify an e2e submits feedback from the card and from the reminder link and sees it in card detail

## 6. Interview prep

- [x] 6.1 Add the `prep-plan.v1` prompt in packages/llm with structured output for the four sections and a test fixture; verify a unit test renders the prompt with a sample posting and profile and parses a fixture response
- [x] 6.2 Implement the pg-boss prep-plan job with public research gathering, one retry, status updates and activity_log entries; verify a worker test with a stubbed LLM produces a ready plan, and a stub that fails twice yields status failed with a log entry
- [x] 6.3 Add the prep-plan enqueue call to the booking step in `interview-scheduling` and the plan link to the reminder in `notifications` when status is ready; verify the scheduling e2e test now shows a ready plan link in the 24h reminder
- [x] 6.4 Expose the plan on card detail and include its link in reminder emails when ready; verify an e2e opens the plan from a card and a notifications test shows the link in the reminder body

## 7. Negotiation support

- [x] 7.1 Add the `comparables-extract.v1` prompt and the Playwright fetch of the levels.fyi public page; verify a unit test extracts percentiles from a saved fixture page and a missing-data fixture yields an empty comparables list
- [x] 7.2 Implement the pg-boss job on transition to offer writing `applications.negotiation` and logging lookup failures; verify a worker test shows the panel data written and, with the fetch stubbed to fail, the range and floor written plus a failure log entry
- [x] 7.3 Build the offer panel in card detail; verify an e2e opens a card in Offer and sees posted range, comparables with source and date, and the salary floor
- [x] 7.4 Add a test asserting no outbound email job is enqueued during the offer transition; verify it passes

## 8. Simulated recruiter and seed data

- [x] 8.1 Write the idempotent `pnpm seed:demo` script creating the demo tenant, user with approved profile, twelve seeded companies and jobs with local fixture forms, one CAPTCHA job, and a seeded run; verify running it twice leaves identical counts
- [x] 8.2 Serve the fixture ATS forms from the worker for Playwright in demo mode; verify an e2e submits one fixture form end to end and the CAPTCHA fixture presents a challenge image
- [x] 8.3 Implement the simulated recruiter job for flagged tenants on seeded jobs: send the three-slot proposal from the sender account with the simulated header within five minutes of status applied; verify a worker test with a stubbed mailer sends once for a flagged tenant and never for an unflagged one or a non-seeded job
- [x] 8.4 Implement confirmation detection and acknowledgement in the same thread, with the unavailable-slot reply; verify worker tests for a matching slot and a non-matching time
- [x] 8.5 Ensure the demo flag has no API write path; verify an API test attempting to set it returns 403 and the value is unchanged
- [x] 8.6 Document demo setup (sender account, seed command, on-demand inbox sync) in docs/DEMO.md; verify a teammate can follow it on a fresh database

## 9. Demo rehearsal

- [x] 9.1 Run the PRD section 12 demo end to end on a fresh database: seed, sign in, trigger a run, watch the run view and board, resolve the CAPTCHA fixture, receive the simulated proposal, confirm a slot, see the card reach Interviewing with calendar event and plan, open the digest and activity log; verify each step within the acceptance timings in PRD section 13 and record the run time in docs/DEMO.md
- [x] 9.2 Run the full test suite and the tenant isolation checks across all new endpoints; verify `pnpm test` and `pnpm test:e2e` pass

## Workflow follow-up

- Archive the change after the demo rehearsal passes.
