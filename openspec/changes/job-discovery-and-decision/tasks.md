# Tasks

## 1. Schema and shared types

- [ ] 1.1 Add Drizzle tables `companies`, `user_companies`, `runs`, `run_candidates`, `jobs` with the unique partial index on `runs(user_id, date)` and verify `pnpm db:migrate` applies cleanly on an empty database
- [ ] 1.2 Add `Candidate` and `Judgment` types plus the judgment JSON schema to `packages/shared` and verify a Vitest test rejects a judgment missing `apply`
- [ ] 1.3 Implement `normalizeJobUrl` and `dedupeKey` in `packages/shared` and verify unit tests cover tracking params, trailing slash, and the three ATS URL shapes

## 2. Company discovery

- [ ] 2.1 Add prompt `company-list@v1` under `packages/llm/prompts` with structured output `{companies: [{name, reason, slug_hints[]}]}` and verify a recorded-fixture test parses a sample response
- [ ] 2.2 Implement `resolveBoard(name, hints)` trying slug variants against Greenhouse, Lever and Ashby public APIs with per-host concurrency 2 and verify tests using mocked HTTP cover resolved, unresolved and timeout cases
- [ ] 2.3 Implement `generateCompanyList(userId)` writing `companies` and `user_companies`, skipping rows with `removed_at`, and verify a test shows a removed company is not re-added on regeneration
- [ ] 2.4 Add API endpoints `POST /companies` (name or board URL) and `DELETE /companies/:id` writing an activity-log user action and verify integration tests for add-by-URL, add-unresolvable (400 naming the three ATSs), and remove
- [ ] 2.5 Document the company resolution flow in `docs/discovery.md` and verify the slug variant rules listed there match the implementation's test fixtures

## 3. Job discovery adapters

- [ ] 3.1 Implement the `SourceAdapter` interface and the `greenhouse`, `lever`, `ashby` adapters mapping board JSON to `Candidate` and verify fixture tests for each ATS produce the captured fields
- [ ] 3.2 Implement the `hn-who-is-hiring` adapter that finds the current month's thread via the HN API and keeps only comments linking to a supported ATS, and verify a fixture test keeps one of three sample comments
- [ ] 3.3 Implement the `linkedin-public` adapter as best-effort with login-wall and rate-limit detection, and verify a test marks the source `unavailable` on a 999 or login redirect without throwing
- [ ] 3.4 Implement `discover(userId)` running adapters with per-source status, in-run dedupe (board data wins over HN), and verify a test with overlapping fixtures yields one candidate carrying board fields
- [ ] 3.5 Implement `dropAlreadyApplied(userId, candidates)` joining `applications` through `jobs` on dedupe key and verify a test drops a candidate matching an existing application by URL only

## 4. Apply decision

- [ ] 4.1 Add prompt `apply-decision@v1` with the structured output schema from design D5 and a cache breakpoint after the profile prefix, and verify a recorded-fixture test parses apply, rationale and null facts
- [ ] 4.2 Implement `judge(candidate, profile, survey)` with one retry on schema failure and `unjudged` marking, and verify tests cover success, retry-then-success, and retry-then-unjudged
- [ ] 4.3 Implement `judgeAll` with concurrency 8 recording prompt version and model per result and verify a test asserts every result carries `apply-decision@v1`
- [ ] 4.4 Implement `rank(approved)` per design D6 and verify tests cover equal fit with different deadlines, null deadline ordering, and exclusion of past deadlines with reason
- [ ] 4.5 Implement `selectTopN(ranked, target)` and daily-target validation (1-30, default 12) on the user settings endpoint and verify tests for 25-approved-target-12 and rejection of 50

## 5. Daily run

- [ ] 5.1 Register pg-boss job `daily-run` with singleton key `daily-run:{userId}:{date}` and a scheduler that enqueues per active user at their run hour, and verify a test shows a second enqueue for the same key is a no-op
- [ ] 5.2 Implement the run orchestrator (profile gate, discover, drop applied, judge, rank, select, hand off, finalize) updating `runs.step` and writing `run_candidates`, and verify an integration test with mocked sources and LLM completes with counts that sum to the fetched total
- [ ] 5.3 Implement hand-off as one transaction (upsert `jobs`, insert `pending` applications with `run_id`, activity log entry) followed by `submit-application` enqueues, and verify a test that fails after 5 inserts leaves 5 rows and a `failed` run
- [ ] 5.4 Implement short-day finalization and the `skipped_no_profile` and `failed` statuses, and verify tests for 4-approved-target-12 (shortfall 8) and unapproved profile (no source fetched)
- [ ] 5.5 Add `POST /runs` (manual trigger) and `GET /runs/:id` returning the run record with candidates in rank order and no `fit` field, and verify an integration test that runs twice on one day creates no duplicate application rows
- [ ] 5.6 Document run statuses, steps and the hand-off contract in `docs/daily-run.md` and verify the status list matches the enum in code

## 6. Integration check

- [ ] 6.1 Run the full daily run against a seeded local database with fixture boards and a recorded LLM fixture and verify: run completes, N applications are `pending`, the run record lists every judged posting with rationale, and `openspec validate job-discovery-and-decision --strict` still passes

## Workflow follow-up

- Archive the change after `application-submission` consumes the `submit-application` hand-off and the integration check passes.
