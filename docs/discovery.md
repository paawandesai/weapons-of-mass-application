# Discovery

How the agent decides which companies to search, fetches their postings, and decides which postings to apply to. The run that chains these steps is described in [daily-run.md](daily-run.md). Rules referenced here come from `docs/design/wave2-daily-run.md`; the discovery pipeline is in `apps/worker/src/discovery/`; the HTTP client, board resolution and board URL helpers shared with the API are the `@wma/discovery` package (`packages/discovery`), so the API never imports worker source.

## Company list

Each user has a list of companies whose public boards are searched. A company is a row in the global `companies` cache (one row per `(ats, board_slug, board_region)`, shared by every tenant; the region is `''` or `eu`, see Board hosts. A name that has no board yet is one `ats is null` row per case-insensitive name, enforced by a partial unique index, so concurrent generations share it); membership in a user's list is a `user_companies` row (`source` is `llm`, `user` or `hn`, with a one-line `reason`, and `removed_at` when the user removed it).

### Generation

`generateCompanyList(handle, userId, deps)`:

1. Requires an approved profile. If there is none it generates nothing and writes a `company_list_skipped` entry with `reason: profile_not_approved`.
2. Sends the profile (identity, history, skills, preferences, survey; never contact details or review flags) to prompt `company-list@v1`. The reply must contain at least 20 companies, each with a one-line `reason` and up to three `slug_hints`. A reply that does not match is retried once; a second failure writes `company_list_failed` and returns.
3. Resolves each distinct name (four at a time):
   - already resolved in the global cache by name: reuse it, no ATS call;
   - unresolved with a retry stamp still in the future: link the unresolved row, no ATS call;
   - otherwise `resolveBoard` (below). Resolved: upsert one company row per board found and link it. Unresolved: upsert an unresolved row with a retry stamp 30 days out and link it, so the user can see it was dropped. ATS unreachable: do nothing for that name, so the next generation or run retries it.
4. Removal is a hard override. Before any lookup, suggestions whose normalized name (the same normalization as slug variants) matches a company the user removed are dropped (counted as `removed`). After resolution, a board the user removed (same ATS, slug and region) is never linked again, even when the model spells the company differently. `upsertUserCompany` also never resurrects a removed row, so regeneration appends without re-adding what the user removed or touching what the user added.
5. Writes `company_list_generated` with the counts.

A user with no list at all gets a generation as the first step of their next daily run.

### Resolving a name to a board

`resolveBoard(name, hints)` asks each ATS's public API whether a board exists for each slug variant, in this order, and the first answer of 200 wins per ATS. A company can therefore resolve on more than one ATS.

| ATS        | URL probed                                                      |
| ---------- | --------------------------------------------------------------- |
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`        |
| Lever      | `https://api.lever.co/v0/postings/{slug}?mode=json`             |
| Ashby      | `https://api.ashbyhq.com/posting-api/job-board/{slug}`          |

A 200 only counts when the body has the board shape (`{jobs: [...]}` for Greenhouse and Ashby, an array for Lever).

Slug variants (at most six, de-duplicated):

1. Normalize the name: lowercase, accents removed, `&` becomes `and`, apostrophes dropped, split on anything that is not a letter or digit, and trailing legal suffixes dropped (`inc`, `llc`, `ltd`, `corp`, `corporation`, `co`, `company`, `gmbh`, `plc`, `sa`, `ag`; a name that is only a suffix keeps it).
2. The words joined with hyphens (`Northwind Labs` gives `northwind-labs`).
3. The words joined without separators (`northwindlabs`).
4. Each LLM hint, stripped to `[a-z0-9-]`. Hints are only hints: every variant is verified against the ATS, so a hallucinated slug is just a 404.

Outcomes: `resolved` (with `partial` set when some other ATS could not be asked), `unresolved` (every ATS answered, none has a board), `unavailable` (nothing found and at least one ATS timed out or returned a server error; never cached as unresolved).

Board hosts. Lever and Greenhouse also run EU deployments (`jobs.eu.lever.co`, `api.eu.lever.co`, `boards.eu.greenhouse.io`, `boards-api.eu.greenhouse.io`). `parseBoardUrl` returns `{ats, boardSlug, region}`; the region is stored on the company row (`board_region`), carried on every `BoardRef`, and used for both the public URL and the API endpoint, so an EU-only board is fetched from the EU host and keeps its public URL. Name resolution probes the default hosts only. Ashby has no EU host and ignores the region.

HTTP behavior shared by every outbound call (`packages/discovery/src/http.ts`): at most 2 concurrent requests per host, a 10 second timeout, and up to two retries with exponential backoff on 429, 5xx, timeouts and network errors. A request holds its host permit until its body has been read, not merely until the headers arrive, so slow downloads cannot exceed the limit; the response handed back is already fully read.

### User edits

- `POST /api/companies` with `{board_url}` parses the ATS and slug from a board or job URL on `boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co` or `jobs.ashbyhq.com` (EU hosts included). No network call, no LLM.
- `POST /api/companies` with `{name}` uses the cache first, then `resolveBoard`. No board: 400 `unresolvable_company`, naming Ashby, Greenhouse and Lever. ATS unreachable: 503 `resolution_unavailable`.
- `DELETE /api/companies/:id` sets `removed_at` and writes a `company_removed` user-action entry; adding writes `company_added`. Adding a removed company again restores it.
- `GET /api/companies` lists the active list, including names that resolved to no board (`resolved: false`).

## Sources

Every source is a `SourceAdapter { id, fetch(ctx) }` that returns `{status, candidates}` where status is `ok`, `partial` or `unavailable`. An adapter never aborts the run; one that throws is recorded as `unavailable`.

| Source id          | What it reads                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `greenhouse`       | every resolved Greenhouse board on the list (`?content=true` for descriptions)                 |
| `lever`            | every resolved Lever board                                                                     |
| `ashby`            | every resolved Ashby board (`includeCompensation=true`); unlisted jobs are skipped            |
| `hn-who-is-hiring` | the current UTC month's thread by `whoishiring`, up to 500 top-level comments                  |
| `linkedin-public`  | anonymous guest search for up to three target roles, then each result page for an outbound link |

Board adapters report `partial` when some boards failed (the slugs are listed in the run's `source_status`) and `unavailable` when all did. Nothing is requested for a company the user removed or one with no resolved board. HN and LinkedIn postings are filtered the same way: a posting whose link points at a removed company's board (ATS, slug and region), or whose company name normalizes to a removed company's name, is dropped before dedupe and counted in `removed_company`; it is not part of `fetched`.

HN: a comment becomes a candidate only if it links to a job (not just a board) on a supported ATS. Greenhouse embedded application links (`boards.greenhouse.io/embed/job_app?for=<slug>&token=<id>`) count: they parse to `(greenhouse, slug, id)`, and normalize to `/embed/job_app?for=<slug>&token=<id>` so two embedded applications never collapse into one URL. Company and role come from the first two `|`-separated fields of the comment; careers pages and email addresses produce nothing. If the month's thread does not exist yet the source is `ok` with no candidates.

LinkedIn: best effort. A 999, 401, 403 or 429, any redirect, or a page that is a login wall or challenge marks the source `unavailable`; nothing depends on it. Only results whose posting links to a supported ATS job URL become candidates (LinkedIn's `safety/go?url=` redirector is unwrapped).

Greenhouse postings hosted on a company's own careers site are given the hosted `job-boards.greenhouse.io/{slug}/jobs/{id}` URL, since that is the form the submission step can drive.

## Dedupe

`dedupeKey` (from `@wma/shared`) is `ats:ats_job_id` when both are known (or can be read from a hosted ATS URL), otherwise the normalized URL: lowercase host, no fragment, no trailing slash, query stripped except posting-id parameters (`gh_jid`); recognized ATS URLs are cut back to board and job id.

- In-run: candidates with the same key collapse to one, and a board candidate wins over an HN or LinkedIn candidate, whatever order the sources answered in. `fetched = deduped + in_run_duplicates`.
- Against history: `dropAlreadyApplied` removes any candidate whose key matches a job the user has an application for, in any status. A candidate matching by URL only is dropped too. Dropped candidates are not judged and not counted as judged.

## Decision

`apply-decision@v1` (`packages/llm/prompts/apply-decision/v1.md`) produces one structured judgment per posting: `apply`, a rationale of at most 600 characters, `fit` (1 to 5, ordering only), pay range and currency, `location_mode`, `seniority` and `application_deadline`, with null for anything the posting does not state. There are no hard filters: a posting below the salary floor is still judged and, if skipped, the rationale says why.

- The system message is the stable prefix: the instructions followed by the profile, ending in a prompt-cache breakpoint. The user message holds the run date and the posting, so only that varies between calls.
- Eight judgments run at a time. A reply that does not match the schema (or a failed call) is retried once; a second failure marks the candidate `unjudged` with `exclusion_reason = unjudged`.
- An over-long rationale is cut to 600 characters rather than discarding the judgment.
- Every result records `prompt_version = apply-decision@v1` and the model.
- The user message renders the structured facts an ATS reports outside the description, inside the posting block and before the description: Lever's `salaryRange` (as `Salary range: min to max CURRENCY (interval)`) and `workplaceType`, Ashby's compensation summary and `isRemote` (`Compensation:`, `Remote: yes|no`) and Greenhouse's departments. Absent facts are omitted. Without them the model could not apply the salary floor or remote preference to a posting that states them only in metadata.

Prompt files start with a frontmatter block (`name`, `version`, `model`, `effort`, `output_schema`, `cache_breakpoint`). A change to a prompt is a new version file, never an edit in place.

### Ranking and selection

Approved candidates are ordered by `fit` descending, then `application_deadline` ascending (none last), then `posted_at` descending (none last), then `dedupeKey` ascending. A deadline before the run date (date-only, UTC) excludes the candidate with reason `deadline_passed`; a deadline equal to the run date is still open. The first `min(target, approved)` are selected. `fit` stays inside the stored judgment and is never returned by any API.
