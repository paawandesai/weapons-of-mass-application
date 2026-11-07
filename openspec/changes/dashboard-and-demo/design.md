# Design

## Context

See proposal.md for motivation. This change is the read side of the system plus the demo employer. It consumes rows written by the other four changes (applications, jobs, interviews, email_threads, activity_log, run records) and adds a small amount of state of its own: user stage overrides, feedback, prep plans, negotiation data, a tenant demo flag and seed data. The stack is fixed in openspec/config.yaml: Hono API, React + Vite web, Drizzle on Postgres, pg-boss workers, Anthropic SDK with claude-opus-5-5.

Constraints that shape the approach:
- The run view must read the daily run's records without creating any persistent job or application for skipped postings.
- The simulated recruiter must be invisible to real tenants and must produce mail that `inbox-sync` reads through the same path as real mail.
- Every read is tenant-scoped; the demo flag is server-set only.

## Goals / Non-Goals

**Goals:**
- One tenant-scoping mechanism for every dashboard query, enforced in the data layer rather than per handler.
- The simulated recruiter exercises the real inbox path so the demo proves the scheduling loop, not a mock of it.
- Seed data that makes the demo plan in PRD section 12 reproducible from an empty database.

**Non-Goals:**
- Interviewer-facing feedback links or voice capture (open question, not designed here).
- Real-time push to the board; polling is enough for the MVP.
- Any learning from feedback or overrides.

## Decisions

**Tenant scoping in the query layer.** Every dashboard query goes through a `forTenant(tenantId)` repository wrapper in packages/db that appends the tenant predicate; handlers never build queries directly. Alternative: Postgres row-level security with a session variable. RLS is stronger but adds connection-setup complexity with pg-boss sharing the pool; revisit after the hackathon.

**Board state is derived, not stored.** Columns are a pure mapping from `applications.status` (pending and applied both map to Applied; pending adds the badge). No board table. User moves write `applications.status` plus a `stage_overrides` row (application_id, from_status, to_status, at) and an activity_log entry with actor user. The agent's workers check `applications.status = 'closed'` before any action; follow-ups and scheduling in `inbox-and-scheduling` already filter on status, so the guard is a shared predicate `isActionable(application)` in packages/shared that both sides use.

**Run view reads run records.** `job-discovery-and-decision` writes a `runs` row (user_id, date, status, step, target_n, started_at, ended_at, counts, short_day, shortfall) and `run_candidates` rows (run_id, rank, company_name, title, url, ats, ats_job_id, judgment jsonb holding verdict and rationale, selected, exclusion_reason) as the run proceeds. Those are the only tables the run view reads; the attempt outcome of a selected candidate is looked up from `applications` by `run_id` plus `(ats, ats_job_id)` through `jobs`. A nightly pg-boss job deletes runs older than seven days. Candidates reference postings by URL and text only, never by a jobs row, which is how "skipped postings leave no trace" holds. The web polls the run endpoint every five seconds while a run is in progress.

**Panic search is a SQL ILIKE over companies joined to the user's applications.** No search index. Alternative: trigram index; unnecessary at MVP volumes.

**Feedback and prep plans live on the interviews row.** `interviews.feedback` (jsonb: notes, relayed, rating, submitted_at, updated_at) and `interviews.prep_plan` (text, markdown) plus `prep_plan_status` (pending, ready, failed). Prep generation is a pg-boss job enqueued by `interview-scheduling` when it books; it calls the prep-plan prompt (packages/llm/prompts/prep-plan.v1) with the posting, the profile and public research gathered by the worker. One retry on failure, then status failed and an activity_log entry. The reminder job in `notifications` includes the plan link when status is ready.

**Negotiation data is a jsonb column on applications.** `applications.negotiation` holds posted_min, posted_max, floor, comparables[] (title, location, p25, p50, p75, source, retrieved_at). A pg-boss job fires on the status transition to offer. levels.fyi has no public API, so the worker fetches the public page for the title and location with Playwright and extracts the percentiles with a structured-output prompt; failures are logged and the panel shows posted range and floor only. No code path in this change sends mail.

**Simulated recruiter injects real mail.** The worker, for tenants with `tenants.demo = true`, listens for status transitions to applied on jobs whose `jobs.seeded = true`. It sends an email to the demo user's Gmail address through a dedicated sender account configured for the droplet, with a recruiter display name per seeded company and a header `X-WMA-Simulated: 1`. Because the message lands in the user's real mailbox, `inbox-sync` picks it up on its hourly cycle exactly like a real recruiter mail; for the demo, the sync can be triggered on demand. Confirmations are detected by polling the same sender account's inbox for replies in the thread and matching the quoted slot. Alternative considered: injecting rows directly into `email_threads`. Rejected because it would bypass the inbox path and prove nothing. The demo flag is a column only migrations or the seed script set; no API writes it.

**Seed script.** `pnpm seed:demo` in packages/db is idempotent by natural keys (tenant slug, user email, company name, job url). It creates the demo tenant, user with an approved profile.json, twelve seeded companies and jobs across Ashby, Greenhouse and Lever shapes with local fixture HTML forms served by the worker for Playwright to fill, one of which presents a CAPTCHA image, and a seeded run so the run view is not empty before the first live run.

**Prompts.** `prep-plan.v1` and `comparables-extract.v1` in packages/llm/prompts, versioned, called with adaptive thinking and structured outputs. Model: claude-opus-5-5. Refusal fallback enabled per the project's LLM gateway defaults.

## Risks / Trade-offs

- [Polling the run view adds load during a run] → five-second interval, only while a run is in progress for that user, and the endpoint returns candidates since a cursor.
- [levels.fyi markup changes break comparables] → extraction is best effort, logged, and the panel degrades to posted range and floor; it is not on the demo's critical path.
- [Simulated mail delivered late or filtered by Gmail] → sender account is a dedicated Google Workspace or Gmail address warmed before the demo; the demo rehearsal task checks delivery time; on-demand inbox sync for the demo.
- [A real tenant accidentally flagged demo] → the flag has no API; the seed script only ever creates the demo tenant slug; a startup assertion logs an error if more than one tenant is flagged.
- [User move races with an agent status update] → the agent's status writes are conditional on the current status it read; a user move that lands first wins and the agent's write is rejected and logged.

## Migration Plan

New columns and tables are additive: `tenants.demo`, `jobs.seeded`, `stage_overrides`, `interviews.feedback`, `interviews.prep_plan`, `interviews.prep_plan_status`, `applications.negotiation`. Deploy by running migrations, then the seed script on the demo environment. Rollback is dropping the additive columns; no data from other changes is altered.

## Open Questions

- Which interviewer-facing feedback mechanism, if any, ships after the hackathon. Deferred; nothing here depends on it.
