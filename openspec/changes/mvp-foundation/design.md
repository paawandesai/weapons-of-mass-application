# Design

## Context

Greenfield repository: no code exists. See proposal.md for motivation. The stack is fixed by openspec/config.yaml (TypeScript on Node 22, pnpm workspaces, Hono API, React + Vite web, Drizzle on Postgres, pg-boss, Playwright, googleapis, Anthropic SDK). This change lays down the monorepo, the first migrations, sign-in, the profile pipeline and the two cross-cutting services (activity log, vault) that every later change calls. The Google OAuth app runs in testing mode for the hackathon (PRD A13): up to 100 listed test users and an unverified-app warning on consent.

## Goals / Non-Goals

**Goals:**
- One consent screen yields sign-in plus the Gmail, Calendar and Drive grants later changes need.
- A profile document shape that later changes can read without renegotiation.
- Vault and activity log APIs stable enough that discovery, applying and inbox changes only call them.
- Tenant scoping enforced in one place so later changes cannot forget it.

**Non-Goals:**
- No LLM-driven profile *reasoning* beyond synthesis into the fixed shape; scoring and tailoring come later.
- No Playwright in this change.
- No learning loop, no multi-user-per-tenant admin UI (a tenant has one user for the MVP, but the schema allows more).

## Decisions

**D1. Monorepo layout.** `apps/web` (React + Vite), `apps/api` (Hono on Node), `apps/worker` (pg-boss consumers), `packages/db` (Drizzle schema, migrations, tenant-scoped query helpers), `packages/llm` (Anthropic client wrapper, versioned prompts, structured output schemas), `packages/shared` (zod schemas for the profile document and API types). Alternative considered: single app. Rejected because the worker and web have different deploy lifecycles even on one droplet, and separating `packages/db` is what lets tenant scoping live in one place.

**D2. Tenant scoping via a request-scoped database context.** Every API request resolves the session, then obtains a `db.forTenant(tenantId)` handle; all repository functions take that handle and add `where tenant_id = $1` themselves. Postgres row-level security is also enabled on every tenant table with a policy keyed on `current_setting('app.tenant_id')`, set per transaction by the handle, so a query that forgets the filter still returns nothing. Alternative: trust application filters only. Rejected because the acceptance criterion "two tenants cannot see each other's data" needs a backstop.

**D3. Sessions.** Server-side sessions in a `sessions` table (id, user_id, tenant_id, expires_at, last_seen_at), cookie holds an opaque session id, HttpOnly, SameSite=Lax, Secure in production. 30-day idle expiry, sliding. Alternative: JWT. Rejected because sign-out must be immediate and revocable.

**D4. Google OAuth flow.** Authorization code flow with PKCE, `access_type=offline`, `prompt=consent` on first sign-in so a refresh token is issued. Scopes: `openid email profile`, `gmail.readonly`, `gmail.send`, `calendar`, `drive.readonly`. Granted scopes are read from the token response and stored; a missing scope marks that source not connected rather than failing sign-in. The refresh token goes into the vault; access tokens are minted on demand and held in memory only.

**D5. Profile document.** One jsonb column on `profiles` validated by a zod schema in `packages/shared`: `identity`, `contact`, `work_history[]`, `projects[]`, `skills[]`, `education[]`, `preferences`, `survey`, `standard_answers`, `flags[]`. Each `work_history`, `projects` and `education` entry carries `sources: string[]` for provenance. Every save inserts a new row with `version = max + 1`; `users.approved_profile_version` points at the approved one. Alternative: separate normalized tables. Rejected for MVP; the document is what the LLM reads and writes.

**D6. Profile build pipeline.** A pg-boss job `profile.build` runs per user: (1) extract text from resume (pdf-parse / mammoth), (2) fetch LinkedIn public page server-side and extract visible text, degrading to headline-only, (3) GitHub REST for public repos and languages, (4) Drive files in selected folders exported as text, (5) one Anthropic call with structured output (`output_config.format` against the profile schema) that synthesizes the document and must cite a source per entry; (6) post-validation rejects any work history entry whose employer string does not appear in any source text, which enforces "never invents". Model `claude-opus-5-5`, adaptive thinking, streaming with `finalMessage()`.

**D7. Vault.** Envelope encryption: `vault_keys(tenant_id, wrapped_dek, created_at)` holds a per-tenant AES-256-GCM data key wrapped with the master key from `VAULT_MASTER_KEY` (32 bytes, base64). `secrets(id, tenant_id, kind, ref, ciphertext, iv, tag, created_at, rotated_at)`; `kind` is `google_refresh_token` or `ats_password`; `ref` is a free string (e.g. ATS plus company). The vault module is the only code that imports the crypto primitives, and its `get` requires the tenant handle from D2. Alternative: a hosted KMS. Rejected for the hackathon; the master key moves to a KMS later without a schema change.

**D8. Activity log.** `activity_log(id, tenant_id, user_id, application_id nullable, at, actor, action, detail jsonb)`. A database rule revokes UPDATE and DELETE from the application role. The log helper is called by every service; a lint rule (custom eslint) flags service functions that do not call it. Secret redaction: the helper refuses `detail` objects whose keys match `/token|password|secret/i`.

**D9. Approval gate.** A single `requireApprovedProfile(userId)` check in `packages/db` used by every pg-boss job handler before doing work. Jobs exit early and log `profile_not_approved`.

## Risks / Trade-offs

- [Google verification] Restricted scopes in testing mode cap us at 100 test users and show a warning → acceptable for the hackathon; listed as A13 and a launch task.
- [LinkedIn fetch blocked] Public profile pages often return a login wall → the build records the source as partial and continues; the resume is the required source.
- [Row-level security complexity] RLS can mask bugs by returning empty results → integration tests assert both the application filter and the RLS backstop independently.
- [LLM invents a role] Synthesis may hallucinate → post-validation against source text; failures surface as flags in review rather than silently dropping.
- [Master key loss] Losing `VAULT_MASTER_KEY` makes every secret unrecoverable → documented in the runbook; users reconnect Google if it happens.

## Migration Plan

Initial migration (Drizzle):
- `tenants(id uuid pk, created_at)`
- `users(id uuid pk, tenant_id fk, email unique, google_sub unique, display_name, approved_profile_version int null, digest_hour int default 8, daily_target int default 12, created_at)`
- `sessions(id text pk, tenant_id, user_id, expires_at, last_seen_at)`
- `source_connections(id, tenant_id, user_id, kind enum[resume, linkedin, github, drive, gmail, calendar], status enum[connected, disconnected, partial], config jsonb, file_ref text null, connected_at, disconnected_at)`
- `profiles(id, tenant_id, user_id, version int, document jsonb, built_from jsonb, created_at; unique(user_id, version))`
- `activity_log` and `vault_keys`, `secrets` as in D7 and D8
- RLS enabled on all of the above with the `app.tenant_id` policy; UPDATE/DELETE revoked on `activity_log`.

Deploy: `pnpm db:migrate` runs on boot of `apps/api`. Rollback: migrations are forward-only; a failed deploy keeps the previous container running.

Environment: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`, `VAULT_MASTER_KEY`, `ANTHROPIC_API_KEY`, `FILE_STORE_DIR`.

## Open Questions

- Whether resume files live on local disk (`FILE_STORE_DIR`) or object storage. Local disk for the droplet; swapping to S3-compatible storage changes one module and no spec.
