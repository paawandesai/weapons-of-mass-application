# LLM cost tracking

Every model call the worker makes is written to the `llm_usage` table with the user it served, the part of the product it served, the prompt, the token counts and an estimated cost in USD. The API sums the table per user, per activity and per application, and the web app shows it on the Usage page and on each application.

## What is recorded

One row per completed `generateStructured` call:

| Column | Meaning |
|---|---|
| `tenant_id`, `user_id` | Whose spend this is. Row-level security applies like every other tenant table. |
| `application_id` | The application the call served, when there is one (tailoring, answers, CAPTCHA, classification of a linked message, prep plan, comparables). Null for onboarding, the company list, judgments and inbox linking. Set to null if the application is deleted; the spend stays. |
| `purpose` | One of `onboarding`, `discovery`, `application`, `inbox`, `interview_prep`, `negotiation` (see below). |
| `prompt` | The prompt id, e.g. `apply-decision/v1`. The finer breakdown within a purpose. |
| `model` | The model id the API reported (what was billed). |
| `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | As the API reported them. |
| `cost_usd` | Estimated at call time from the price table in `packages/llm/src/pricing.ts`. Null when the model has no entry there: the row still counts, the Usage page reports it as "not priced". |
| `duration_ms` | Wall time of the call. |

A call that throws (transport or API error) returns no usage from the API and is not recorded. A retry that then succeeds is recorded like any other call, so a prompt that needed two attempts shows two rows.

## Purposes

| Purpose | Jobs | Prompts |
|---|---|---|
| `onboarding` | `profile.build`, started by the survey save, a resume upload, or "Rebuild" on the profile page | `profile-build/v1` |
| `discovery` | `daily-run` | `company-list/v1`, `apply-decision/v1` |
| `application` | `submit-application` | `tailor-resume/v1`, `extract-resume-facts/v1`, `classify-form-field/v1`, `answer-form-question/v1`, `solve-captcha-a/v1`, `solve-captcha-b/v1` |
| `inbox` | `mail-sync` | `inbox-link/v1`, `inbox-classify/v1` |
| `interview_prep` | `prep-plan` | `prep-plan/v1` |
| `negotiation` | `negotiation` | `comparables-extract/v1` |

The survey itself makes no model call. Saving it starts the first profile build, and that build is what shows under onboarding.

## How it is wired

`trackLlm(llm, sink, scope)` in `@wma/llm` wraps the `StructuredLlm` port: it forwards the call, then hands one `LlmCallRecord` to the sink. A sink failure is logged and swallowed, so the ledger can never fail the job it measures. The worker's `meterLlm(handle, userId, purpose, llm, applicationId?)` binds the sink to `recordLlmUsage` on the tenant handle.

Each job wraps its injected client at the point where the tenant handle and user are known: `runProfileBuild`, `executeDailyRun`, the submission context in `submission/job.ts`, `runMailSync`, `generatePrepPlan` and `runNegotiation`. A call that serves a specific application sets `applicationId` on the request (classification does this once the message is linked); otherwise the scope's application applies. Tests that call these functions with a `FakeLlm` record zero-token rows, which is how the wiring is asserted.

Prices are first-party Anthropic list prices. Cache writes are priced at the 5-minute ephemeral rate, the only one the client uses. When a price changes, update the table and the new rate applies to new rows; stored rows keep the cost at the time of the call.

## Reading it

- `GET /api/usage?window=all|7d|30d` returns totals, the breakdown by purpose and by application (labelled with company and title, most expensive first), and the last 50 calls.
- `GET /api/interviews/for-application/:id` includes `llm_usage` totals for that application.
- The Usage page (`/usage`) shows the same, and each application's detail shows its own cost with a link there.

Operational totals across tenants (the "$25 cap" kind of question) are a Postgres query by the owner role, since the application role is tenant-scoped:

```sql
select purpose, count(*) as calls, round(sum(cost_usd), 4) as usd
from llm_usage where at > now() - interval '1 day'
group by purpose order by usd desc;
```

## Not done

- No budget enforcement: the ledger reports, it does not stop a job. A per-user or per-tenant cap would read `totalLlmUsage` before each job and be a small follow-up.
- Failed calls are not recorded (the API returns no usage for them).
- Prices are a static table, not read from the API.
