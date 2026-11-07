# Design

## Context

See proposal.md for motivation. Constraints that shape this design: the run is stateless by decision (PRD 4, 7.2), nothing is stored for a posting unless it is handed off, three ATSs with public read APIs organized per company board, and one droplet with Postgres as the only datastore. `tenancy`, `profile` (approved profile document, daily target, run hour) and `activity-log` already exist from `mvp-foundation`.

## Goals / Non-Goals

**Goals:**
- A run for one user finishes in under 10 minutes with 60 boards and about 500 postings.
- Every LLM call has a versioned prompt and a validated structured output.
- Source failures degrade the run, never abort it.
- Re-running on the same day is idempotent with respect to application rows.

**Non-Goals:**
- Any persistence of unselected candidates beyond the run record.
- Scoring thresholds, near-miss surfacing, pairwise ranking.
- Browser automation for discovery; all discovery is HTTP fetch plus HTML or JSON parsing.

## Decisions

**D1. Discovery sources are adapters behind one interface.** `SourceAdapter { id, fetch(ctx): Candidate[] }` with implementations `ashby`, `greenhouse`, `lever`, `hn-who-is-hiring`, `linkedin-public`. Each adapter returns normalized `Candidate` objects and reports per-source status (ok, partial, unavailable) to the run record. Alternative considered: one scraper module per run step. Rejected because sources differ in failure modes and the run record needs per-source status.

**D2. ATS board resolution tries slug variants against each public API.** For a company name, generate slugs (lowercase, hyphenated, concatenated, known aliases from the LLM), then `GET` Greenhouse `boards-api.greenhouse.io/v1/boards/{slug}/jobs`, Lever `api.lever.co/v0/postings/{slug}`, Ashby `api.ashbyhq.com/posting-api/job-board/{slug}`. First 200 wins per ATS. Results cached in `companies` (global, not per tenant) with `resolved_at`; unresolved names cached with a 30-day retry stamp. Alternative: ask the LLM for the slug. Used only as a hint, since it hallucinates.

**D3. User list is a join table.** `user_companies(user_id, company_id, source: llm|user|hn, removed_at)`. Removal sets `removed_at`; regeneration skips rows with `removed_at`. This keeps the global company cache separate from per-user membership.

**D4. URL normalization.** Lowercase host, strip query parameters except ATS job ids, strip trailing slash and fragment, map known ATS URL shapes to `(ats, ats_job_id)`. Dedupe key is `(ats, ats_job_id)` when known, else the normalized URL. Same function is used at run time and when application rows are written, so both sides agree.

**D5. Decision is one structured-output call per posting, run with bounded concurrency.** Prompt `apply-decision@v1` takes the posting, the profile document and survey; output schema:

```json
{
  "apply": "boolean",
  "rationale": "string (<= 600 chars)",
  "fit": "integer 1-5, internal ordering hint only",
  "pay_min": "integer | null",
  "pay_max": "integer | null",
  "currency": "string | null",
  "location_mode": "onsite | hybrid | remote | null",
  "seniority": "string | null",
  "application_deadline": "YYYY-MM-DD | null"
}
```

`fit` is used only to order within the run and is never shown as a score; the spec forbids thresholds, and the selection is top N by order. Concurrency 8, retry once on schema failure, then mark unjudged. Alternative: one call that judges the whole batch. Rejected: long context, no per-posting retry, worse caching.

**D6. Ranking is deterministic from judgment fields.** Sort approved candidates by `fit` desc, then `application_deadline` asc (nulls last), then posted date desc. No second LLM call. A `rank-candidates` prompt is reserved for later but not used in v1, so ranking cost is zero and reproducible.

**D7. Versioned prompts.** `packages/llm/prompts/<name>/v<N>.md` with a frontmatter block (model, output schema file, effort). The gateway records `prompt_name@vN` and model id on every call result; run_candidates store it. Changing a prompt means adding a new version file, never editing one in place.

**D8. LLM calls.** `@anthropic-ai/sdk`, model `claude-opus-5-5`, adaptive thinking, `output_config.format` for the schema above, streaming not needed for these short outputs. The profile document is placed first in the prompt with a cache breakpoint so the per-posting suffix is the only varying part.

**D9. Run orchestration in pg-boss.** Job `daily-run` keyed `daily-run:{user_id}:{date}` with singleton semantics so the scheduler and a manual trigger cannot double-start. The job: load profile, fetch sources, dedupe, judge, rank, select, hand off, finalize. Each step updates `runs.step` so a failed run shows where it stopped.

**D10. Hand-off is a transactional write plus a queue message.** Within one transaction: insert `jobs` rows (upsert on `(ats, ats_job_id)`), insert `applications` rows with status `pending` and `run_id`, write the activity log entry. Then enqueue `submit-application` per application id. The submission change owns that consumer. Partial failure leaves committed rows for the earlier candidates, which is acceptable because dedupe drops them on retry.

**D11. Tables.**

```
companies(id, name, ats, board_slug, board_url, resolved_at, unresolved_until, created_by)
user_companies(tenant_id, user_id, company_id, source, reason, added_at, removed_at)
runs(id, tenant_id, user_id, date, trigger, status, step, target_n, started_at, ended_at,
     source_status jsonb, counts jsonb, short_day bool, shortfall int, error text)
run_candidates(id, run_id, tenant_id, title, company_name, url, ats, ats_job_id,
     judgment jsonb, prompt_version, model, rank int, selected bool, exclusion_reason)
jobs(id, tenant_id, company_id, ats, ats_job_id, title, url, description, location,
     location_mode, pay_min, pay_max, posted_at, raw jsonb)  -- written only at hand-off
```

`applications` is defined by `application-submission`; this change only requires `status`, `job_id`, `run_id` on it and the dedupe lookup by `(ats, ats_job_id)` or normalized URL joined through `jobs`.

## Risks / Trade-offs

- [LLM company list is shallow or biased to well-known names] → surface the list in the UI for edits (`company-discovery` user add/remove), and seed from HN companies that link to supported boards.
- [ATS public APIs rate-limit a 60-board sweep] → per-host concurrency 2, exponential backoff, mark board `partial` rather than retry forever.
- [LinkedIn public search blocked most of the time] → it is best-effort by spec; the run record shows it as unavailable and nothing depends on it.
- [`fit` leaks into product as a score] → it is stored inside `judgment` only and never exposed by the run view API; the spec names rationale and order as the user-facing outputs.
- [Judging 500 postings per user per day is expensive] → prompt caching on the profile prefix; a cheaper model for judgment can be swapped by prompt frontmatter without a code change.
- [Two runs race on the same day] → pg-boss singleton key plus the `(user_id, date, status != failed)` unique partial index on `runs`.

## Open Questions

- Whether HN comments without a supported ATS link should be kept for company discovery only (not job discovery). Deferrable; current spec drops them.
