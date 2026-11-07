# Design brief: daily run, dedupe, ranking, hand-off

Purpose: once a day per user, find postings, judge them, apply to the top N, and store only what was applied to. Read by the run view and by the submission job.

Inputs: approved profile document and survey (from `requireApprovedProfile`); `users.daily_target` (int 1..30); user's company list (`user_companies` join `companies`); adapters: greenhouse, lever, ashby board JSON, HN "Who is hiring" via the HN Firebase API, linkedin-public HTML (best effort); existing `applications` joined to `jobs` for dedupe. Dates: posting dates as ISO; deadlines as `YYYY-MM-DD`; "today" is the user's run date in UTC.

Units: n/a. `fit` is an integer 1..5 used only for ordering, never exposed by any API.

Rules:
1. A run MUST start by calling `requireApprovedProfile`; on throw it writes `runs.status = skipped_no_profile`, logs `profile_not_approved`, and fetches no source.
2. At most one non-failed run per `(user_id, date)`: partial unique index on `runs(user_id, date) where status <> 'failed'`, plus pg-boss singleton key `daily-run:{userId}:{date}`. A second trigger MUST return the existing run id.
3. Each adapter runs independently; an adapter failure sets `source_status[id] = unavailable` (or `partial` if some boards failed) and the run continues. A run with every source unavailable finishes `short_day` with `shortfall = target`.
4. `dedupeKey(candidate)` MUST be `ats:ats_job_id` when both are known, else the normalized URL (lowercase host, no fragment, no trailing slash, query stripped except ATS job id params). The same function is used for in-run dedupe and for the applied lookup.
5. In-run dedupe keeps the board candidate over the HN candidate for the same key.
6. `dropAlreadyApplied` MUST remove any candidate whose key matches an existing `applications` row of this user (any status) via `jobs`.
7. Each remaining candidate gets exactly one `apply-decision@v1` call with structured output; schema failure retries once, then the candidate is `unjudged` with `exclusion_reason = unjudged`. Concurrency 8.
8. Ranking of approved candidates: `fit` desc, then `application_deadline` asc with nulls last, then `posted_at` desc, then `dedupeKey` asc as a final deterministic tiebreak. Candidates whose deadline is before today are excluded with reason `deadline_passed`.
9. Selection is the first `min(target, approved)` of the ranked list; `selected = true` on those `run_candidates` rows, `rank` set on every ranked row.
10. Hand-off is one transaction: upsert `jobs` on `(ats, ats_job_id)` (or `(tenant_id, url)` when no ATS id), insert `applications(status = pending, run_id, attempt_count = 0)`, one `activity_log` entry `handed_off` with `{run_id, count}`; after commit, enqueue `submit-application` per application id with singleton key = application id. A failure mid-transaction rolls back every row of that run.
11. Finalization writes `counts = {fetched, deduped, already_applied, judged, approved, unjudged, selected}` and `short_day = selected < target` with `shortfall = target - selected`; `counts.fetched` MUST equal `deduped + in_run_duplicates` and every judged candidate MUST have a `run_candidates` row.
12. `GET /runs/:id` returns candidates in rank order with rationale and selection, and MUST NOT include `fit`.
13. A run older than 7 days is deleted with its candidates by a nightly job; `jobs` and `applications` are never deleted by it.

Edge cases: a posting with no deadline and low fit still ranks above a passed-deadline posting (which is excluded). Zero approved is a valid short day. The same posting on two boards (company moved ATS) is two keys and may be applied to twice; acceptable. A company removed by the user (`removed_at`) is skipped by regeneration and by discovery.

Time: run date is `date_trunc('day', now() at time zone 'UTC')`; deadline comparison is date-only in UTC.

Failure handling: per adapter (rule 3); per candidate (rule 7); whole-run failure only when the profile gate throws (rule 1), the hand-off transaction fails (rule 10, status `failed` with `error` and `step`), or an unhandled error occurs (status `failed`). A failed run releases the date so a retry can run.

Consistency: the candidate list is held in memory for the run; `run_candidates` rows are inserted after judging in one batch; hand-off reads nothing it did not produce.

Outputs: `runs`, `run_candidates`, `jobs`, `applications` rows; activity entries `run_started`, `handed_off`, `run_finished` (or `run_failed`, `profile_not_approved`); `POST /runs` (manual trigger, returns existing run on the same day), `GET /runs/:id`, `GET /runs/latest`.

Tests: one per rule 1..13; two runs same day produce one run and no duplicate applications; counts sum; a 5-row hand-off that fails on the 6th leaves 0 rows and a failed run; ranking tiebreaks; URL normalization for the three ATS shapes and tracking params; HN comment with a non-ATS link dropped.

Out of scope: scoring thresholds, near-miss surfacing, pairwise, LinkedIn login, learning.
