# Proposal

## Why

The agent cannot apply to anything until it can find postings and decide which ones are worth a user's daily budget. This change builds the stateless daily run that the whole product rests on: discover, judge, rank, and hand the top N to submission, storing nothing it did not act on.

Implements PRD v1.2 sections 4 (Daily run row), 7.2 Discovery, 7.3 Decision, 8 (companies and jobs tables), 9 (scheduler), 12 step 2 (run data behind the run view), 13 (no duplicate applications on a second run), and assumptions A2, A9, A10.

## What Changes

- An LLM-generated company list per user, resolved to Ashby, Greenhouse and Lever board slugs and cached; users can add and remove companies.
- Posting fetch from the three board APIs, the HN "Who is hiring" thread, and best-effort LinkedIn public job search.
- Dedupe against the user's existing application rows by ATS job id or normalized URL, so a second run on the same day produces no duplicates.
- One LLM judgment per posting: apply yes/no, rationale, extracted facts (pay range, location mode, seniority, deadline).
- Ranking of approved postings with fit first and stated deadline as tiebreaker; the top N (default 12, range 1-30, per user) are handed to the submission pipeline, the rest discarded.
- Short-day reporting when fewer than N postings qualify.
- Run records (per user per day) that the run view and digest can read, including every judged posting and its rationale for that run only.
- A scheduler that triggers one run per user per day at a configurable hour.
- A hand-off contract: the run emits an ordered list of candidates; submission consumes it. Submission itself is a separate change.

## Capabilities

### New Capabilities
- `company-discovery`: building and maintaining the per-user list of companies whose ATS boards are searched
- `job-discovery`: fetching current postings from the configured sources and dropping ones already applied to
- `apply-decision`: judging each posting against the profile and ranking approved postings
- `daily-run`: the scheduled, stateless run that chains discovery, decision and hand-off, and records what happened

### Modified Capabilities
- None. `tenancy`, `profile` and `activity-log` from the `mvp-foundation` change are consumed as-is.

## Out of Scope

- Application submission, resume tailoring, ATS accounts, CAPTCHA handling (`application-submission` change).
- Inbox sync, scheduling, digest email (`inbox-and-scheduling` change). This change only exposes run records the digest reads.
- Any web UI, including the run view (`dashboard-and-demo` change).
- A stored queue of unapplied postings, a Found stage, numeric scores or thresholds, near-miss surfacing, pairwise comparison, learning from outcomes.
- Logged-in LinkedIn or Indeed access.

## Impact

- New tables: `companies`, `jobs` (written only at hand-off), `runs`, `run_candidates`, `user_companies`.
- New worker jobs: `discover-companies`, `daily-run`.
- New LLM prompts: `company-list`, `apply-decision`, `rank-candidates`, versioned under `packages/llm/prompts`.
- Outbound HTTP to Ashby, Greenhouse and Lever public APIs, Hacker News, and LinkedIn public pages (rate-limited, no credentials).
- Depends on `tenancy` (tenant scoping), `profile` (approved profile document and daily target), `activity-log` (recording run outcomes).
