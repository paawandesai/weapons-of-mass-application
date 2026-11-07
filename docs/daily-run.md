# Daily run

One run per user per day: discover, judge, rank, hand the top N to submission, record what happened. It is stateless between days: every run fetches fresh postings and judges them again, and nothing is stored for a posting that was not handed off beyond the run record. Design rules are in `docs/design/wave2-daily-run.md`; the discovery steps are in [discovery.md](discovery.md).

## Triggers

- Scheduler: an hourly tick (`daily-run-tick`) enqueues one `daily-run` job for every user with an approved profile whose run hour is the current UTC hour. The run hour is the user's configured hour (`users.digest_hour`). Row-level security hides other tenants from the application role, so the tick enumerates users through the SECURITY DEFINER function `wma_run_roster()`, which returns only `(tenant_id, user_id, run_hour)` for users with an approved profile and is callable by the application role and nobody else. The worker never connects as the database owner; all work for a user then goes through a tenant-scoped handle.
- Manual: `POST /api/runs`. An existing non-failed run for today is returned as is (200); otherwise the run is queued (202) and the worker takes it from there. The run page has a "Run today" button that calls it. A user without an approved profile gets a `skipped_no_profile` run immediately.

Manual dispatch is recorded on the run as `dispatch_state`: `queued` (row committed, not yet sent), `dispatched` (pg-boss accepted the job) or `failed` (sending threw, or pg-boss declined it because a job with the same singleton key was still outstanding). A queued run whose state is `failed` is sent again by the next `POST /api/runs`, which first flips the state back to `queued` with a compare-and-set so concurrent triggers send it once; while the dispatch is failed the endpoint answers 503 `dispatch_failed` with the run. The day therefore never stays reserved without executable work. Taking over a `skipped_no_profile` run (API after approval, or a worker) is likewise `update ... where status = 'skipped_no_profile'`: whoever loses sees the winner's run and changes nothing.

Both paths use the pg-boss singleton key `daily-run:{userId}:{date}` on an exclusive queue, backed by the partial unique index on `runs(user_id, date) where status <> 'failed'`. A second trigger while a job is queued or running enqueues nothing; a second trigger after the run has ended finds the existing run and records `run_skipped`. A failed run frees the date for a retry.

A nightly job (`daily-run-cleanup`) deletes runs dated more than 7 days ago, with their candidates. It finds the tenants to visit through `wma_stale_runs(cutoff)` (also SECURITY DEFINER, ids only), then deletes through each tenant's handle. It never touches `jobs` or `applications`; `applications.run_id` is set to null.

## Statuses

Run status (`runs.status`):

<!-- statuses -->
- `running`
- `finished`
- `short_day`
- `skipped_no_profile`
- `failed`
<!-- /statuses -->

`finished`: at least the daily target was handed off. `short_day`: fewer than the target were handed off (including zero, and every source being unavailable); `short_day = true` and `shortfall = target - selected`. `skipped_no_profile`: the profile was not approved, no source was fetched. `failed`: the hand-off transaction or an unhandled error; `error` and `step` say where. A `skipped_no_profile` run can be taken over by a later trigger on the same day once the profile is approved; a `running` run left behind by a worker that died (over an hour old) is marked `failed` and replaced.

## Steps

`runs.step` shows where a run is, or where it stopped:

<!-- steps -->
- `queued` (accepted by the API, waiting for the worker)
- `start`
- `companies`
- `fetch`
- `dedupe`
- `judge`
- `rank`
- `hand_off`
- `finalize`
<!-- /steps -->

1. `start`: claim the (user, date) slot, write `run_started`, check the approved-profile gate.
2. `companies`: generate the company list if the user has none.
3. `fetch`: run all sources; write `source_status` per source.
4. `dedupe`: in-run dedupe happened in `fetch`; drop candidates already applied to.
5. `judge`: one `apply-decision@v1` call per remaining candidate.
6. `rank`: order approved candidates, exclude passed deadlines, take the top N, write one `run_candidates` row per judged or unjudged candidate in one batch.
7. `hand_off`: described below.
8. `finalize`: status, counts, short-day fields, `run_finished`.

## Counts

`runs.counts` is `{fetched, deduped, already_applied, judged, approved, unjudged, selected}` plus `in_run_duplicates`, `skipped`, `over_cap`, `deadline_passed`, `over_target`, `requeued`, `removed_company` and `hand_off_conflicts`. `over_cap` counts postings left unjudged because the run reached its judge cap (below); they get no `run_candidates` row. `removed_company` counts HN and LinkedIn postings dropped because the user removed that company; they are not part of `fetched`. `hand_off_conflicts` counts selected postings that another run (for a different date) had already turned into an application. They add up:

- `fetched = deduped + in_run_duplicates`
- `deduped = already_applied + over_cap + unjudged + judged`
- `fetched = in_run_duplicates + already_applied + over_cap + unjudged + judged`
- `judged = skipped + approved`

Every judged and unjudged candidate has a `run_candidates` row (`judged + unjudged` rows). `exclusion_reason` is one of `unjudged`, `not_approved`, `deadline_passed`, `over_target` or `already_applied` (selected, but another run's hand-off got the posting first; its `selected` flag is cleared). A selected row has none, and `counts.selected` always equals the number of selected rows and of applications created by the run.

## Judge cap

Every run judges at most `JUDGE_CAP_PER_RUN` postings (default 120; a value that is not an integer of 1 or more falls back to 120 and is logged once when the worker starts). The cap applies after already-applied postings are dropped and before judging. Postings are ordered seeded source first, then newest `postedAt` first, undated last, ties in the order the sources returned them; the first `JUDGE_CAP_PER_RUN` are judged and the rest are counted in `over_cap`. When any are dropped the run writes one `judge_capped` activity entry `{run_id, cap, dropped}`.

## Demo tenant

A tenant flagged `demo` searches only its seeded postings (no board, HN or LinkedIn source) and never generates a company list: the `companies` step writes `company_list_skipped` with reason `demo_tenant` instead. Judging, ranking and hand-off are unchanged.

## Hand-off contract

The run emits an ordered list: each entry carries the posting fields, the judgment and the rank. In one database transaction, holding the user's advisory lock, it first re-reads the user's existing applications (so a run for another date that overlaps this one cannot claim the same posting twice) and then:

1. upserts a `jobs` row per entry (on `(ats, ats_job_id)`, or `(tenant, url)` when there is no ATS id) with the normalized URL and the pay, currency and location mode the judgment extracted;
2. inserts an `applications` row per entry with `status = pending`, `attempt_count = 0` and `run_id`;
3. writes one `handed_off` activity entry `{run_id, count}`.

Any failure rolls back every row of that run, and the run ends `failed` at step `hand_off`. After the commit, one `submit-application` message per new application is enqueued with `{tenantId, userId, applicationId}` and the application id as the singleton key. An enqueue failure does not fail the run; it writes `handoff_enqueue_failed` and the row stays pending.

The producer creates the `submit-application` queue with the consumer's options (`SUBMIT_QUEUE_OPTIONS`) and sends every message with them plus the singleton key.

The same step recovers pending applications from earlier hand-offs. A row at `attempt_count = 0` of any date is enqueued again when pg-boss has no live (created, retry or active) job for its id: this repairs a crash after the hand-off commit, a failed enqueue and a failed job, even on the same day, where the replacement run would otherwise drop the posting as already applied. A row at `attempt_count = 1` gets its single retry only on a later date than the one it was created on, so a second run on the same day cannot spend it.

The judgment (including facts such as pay and deadline) stays readable to the submission step in `run_candidates.judgment` while the run exists.

## Activity log

`run_started`, `handed_off`, `run_finished` (status and counts), or `run_failed` (step and error). Also `profile_not_approved`, `run_skipped`, `company_list_generated`, `company_list_skipped` (reason `profile_not_approved`, or `demo_tenant` for a demo tenant), `judge_capped`, `company_list_failed`, `handoff_enqueue_failed`, and the user actions `company_added` and `company_removed`.

## API

- `POST /api/runs`: manual trigger, described above.
- `GET /api/runs/latest` and `GET /api/runs/:id`: `{run, candidates}`. The run has `id, date, trigger, status, step, target, started_at, ended_at, source_status, counts, short_day, shortfall, error`. Candidates are in rank order (ranked first, then the rest) with `rank, title, company, url, ats, apply, rationale, selected, exclusion_reason`, the extracted facts, `prompt_version` and `model`. `fit` is never returned.
