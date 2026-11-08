# Run view, interview feedback, prep plans and negotiation support

Design rules 3, 7, 8, 9 and 10 of `docs/design/wave4-dashboard-demo.md` are implemented here. This page says where each lives and how to run it.

## Run view (rule 7)

- `GET /api/runs/current` returns the user's in-progress run, or the latest one, with `counts` and `candidates` in rank order (ranked rows first, unranked last). Each candidate carries company, title, verdict (`apply`), `rationale`, `selected` and `exclusion_reason`. The internal `fit` hint is never part of the view.
- `?cursor=` returns only the candidates after the last one the client saw; `next_cursor` and `has_more` page the rest (`?limit=`, default 50, max 200). A cursor issued for another run is ignored and the list starts over.
- A user with no run gets `run: null` and `next_run_at` (the user's run hour, UTC, after approval).
- The page (`apps/web/src/pages/RunViewPage.tsx`) polls every five seconds only while the run status is `running`.
- Runs older than seven days are deleted nightly by `cleanupOldRuns` (`apps/worker/src/jobs/daily-run.ts`); skipped postings never become jobs or applications (`apps/worker/test/discovery/run.test.ts`).

## Interview feedback (rule 8)

- `POST /api/interviews/:id/feedback` creates, `PUT` edits. Body `{notes, relayed, rating 1..5|null}`; text is trimmed.
- Stored on `interviews.feedback` as `{notes, relayed, rating, submitted_at, updated_at}`. An edit keeps `submitted_at`.
- Creating or editing needs non-empty `notes` or `relayed`; otherwise 400 `empty_feedback`. A second create is 409, an edit with nothing to edit is 404.
- Each save writes a user-actor activity entry (`feedback_submitted` / `feedback_edited`) naming the fields, never the text.
- Web: the form on the card (`CardExtras`) and the deep link `/interviews/:id/feedback`.

## Prep plan (rule 9)

- Job `prep-plan` (`apps/worker/src/jobs/prep-plan.ts`, logic in `apps/worker/src/prep/`). Enqueued by the booking step (`bookInterview` records it in the outbox after the card moves to Interviewing), by `recordConfirmedInterview` for an interview whose time arrived already fixed (a confirmation email with a `confirmed_slot`, or the user's own entry through `POST /api/interviews/for-application/:id/record`), and on demand by `POST /api/interviews/:id/prep-plan`. An interview that exists only as a thread with a booking link, or as a card moved to Interviewing by hand, has no plan until one of those happens; the card offers a "Record an interview" form for that case.
- Booking enqueues with `onlyIfMissing`, so a repeated booking never replaces an existing plan. On demand always regenerates.
- On demand is idempotent while pending: the interview row is locked, the status set to `pending`, and a second request enqueues nothing. The queue also holds a singleton key per interview.
- Research is the posting and the company's board page text (`@wma/discovery` http client), nothing else. An unreadable board page is not an error.
- The `prep-plan@v1` prompt returns `{likely_questions[{question, answer_outline}], topics[], company_research, interviewer_background|null}`. It is stored as JSON text in `interviews.prep_plan`. `interviewer_background` is forced to null unless the interviewer is named.
- One retry inside the job; two failures set `prep_plan_status = failed` and write `prep_plan_failed`. Success writes `prep_plan_ready`. The card's status is never touched.
- Reminder emails link `/interviews/:id/prep` when the status is `ready`.

## Negotiation support (rule 10)

- Job `negotiation` (`apps/worker/src/jobs/negotiation.ts`, logic in `apps/worker/src/negotiation/`). The inbox sync enqueues it once a message moves an application to `offer` (`applyTransition`'s `onTransition` option records the change inside the transaction; the enqueue happens after commit). `POST /api/interviews/for-application/:id/negotiation` starts it for a card moved to Offer by hand.
- It writes `applications.negotiation = {posted_min, posted_max, currency, floor, comparables[], fetched_at, error}`: the range from the job, the floor from the approved profile survey, comparables from the public levels.fyi page for the job title and location.
- The page is fetched in the worker's shared Playwright browser (`createPlaywrightLevelsFetcher`). Set `LEVELS_FYI_BASE_URL` to point it at another origin (tests use a local server and a saved page). The text goes through the `comparables-extract@v1` prompt.
- A failed fetch, a failed extraction or a page without figures still writes range and floor, sets `error` (`fetch_failed`, `extract_failed`, `no_data`) and logs `comparables_failed`.
- No code path sends, drafts or queues mail. `apps/worker/test/negotiation/negotiation.test.ts` drives an offer email through the real sync and asserts the only queued job is `negotiation` and that no `outgoing_messages` row exists.

## Card integration

`apps/web/src/components/card-extras` exports `CardExtras({application})`. `application` needs `id` and `status`; `interviews` and `negotiation` may be passed from card detail, otherwise the component loads both from `GET /api/interviews/for-application/:applicationId`. It renders, per interview, the prep plan panel (Generate / status / link) and the feedback form, and the offer panel for cards in Offer.

## Tests

- API: `apps/api/test/runs-current.test.ts`, `apps/api/test/interviews.test.ts`
- Worker: `apps/worker/test/prep/`, `apps/worker/test/negotiation/`
- Web: `apps/web/test/run-view.test.tsx`, `apps/web/test/card-extras.test.tsx`
- End to end (skipped when the seed data is absent): `apps/web/e2e/{runs,feedback,prep,offer}.spec.ts`
