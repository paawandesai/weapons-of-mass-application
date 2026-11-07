# Tasks

## 1. Repository scaffold

- [ ] 1.1 Create the pnpm workspace with `apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/llm`, `packages/shared`, shared tsconfig and eslint; verify `pnpm install && pnpm -r typecheck` passes
- [ ] 1.2 Add `docker-compose.yml` with Postgres 16 and a `.env.example` listing every variable in design.md; verify `docker compose up -d && pnpm db:migrate` runs against an empty database
- [ ] 1.3 Add Vitest to every package and a root `pnpm test`; verify a placeholder test runs in each package

## 2. Database and tenancy

- [ ] 2.1 Write the Drizzle schema and initial migration for tenants, users, sessions, source_connections, profiles, activity_log, vault_keys, secrets; verify `pnpm db:migrate` applies cleanly and `pnpm db:check` reports no drift
- [ ] 2.2 Enable row-level security with the `app.tenant_id` policy on every tenant table and revoke UPDATE/DELETE on activity_log; verify an integration test that sets tenant A and selects tenant B's row gets nothing, and an UPDATE on activity_log fails
- [ ] 2.3 Implement `db.forTenant(tenantId)` that sets `app.tenant_id` per transaction and the repository helpers that always filter by tenant; verify unit tests covering the tenancy spec scenarios (write stamps tenant, cross-tenant read is not found, forged tenant id ignored)

## 3. Vault and activity log

- [ ] 3.1 Implement the vault module: per-tenant data key creation, wrap/unwrap with `VAULT_MASTER_KEY`, AES-256-GCM encrypt/decrypt, `put`, `get`, `rotate`, `delete`; verify unit tests show ciphertext-only rows, cross-tenant get fails, delete makes get fail, and startup without the master key exits non-zero
- [ ] 3.2 Implement the activity log helper with secret-key redaction and the per-user and per-application readers; verify unit tests cover append, newest-first read, cross-tenant read not found, and rejection of a detail object containing a `token` key
- [ ] 3.3 Wire vault put/rotate/delete and failed decrypts to the activity log; verify a test asserting each vault operation writes exactly one entry with no secret material

## 4. Google sign-in and sessions

- [ ] 4.1 Register the Google OAuth app in testing mode with the five scopes and document the console steps in `docs/setup/google-oauth.md`; verify the documented steps produce a working client id against a local callback
- [ ] 4.2 Implement the authorization-code-with-PKCE flow in `apps/api`: start, callback, tenant and user creation on first sign-in, unverified-email refusal, granted-scope capture, refresh token into the vault; verify integration tests with a mocked token endpoint cover first sign-in, returning sign-in, unverified email and a declined scope
- [ ] 4.3 Implement server-side sessions with the HttpOnly cookie, 30-day sliding expiry and sign-out; verify tests for sign-out invalidation and expired-session rejection
- [ ] 4.4 Implement revoked-token detection in the Google client wrapper that marks gmail, calendar and drive disconnected and logs it; verify a test simulating an `invalid_grant` response flips the connection status and writes the log entry
- [ ] 4.5 Build the sign-in page and the connections page in `apps/web` showing each Google scope as connected or missing; verify in the running app that declining Drive shows Drive as not connected

## 5. Profile sources

- [ ] 5.1 Implement resume upload (PDF or DOCX, 10 MB cap) to `FILE_STORE_DIR` with text extraction; verify tests for accepted PDF, accepted DOCX, rejected PNG, rejected oversize, and extracted text non-empty for a fixture resume
- [ ] 5.2 Implement LinkedIn public URL, GitHub username and Drive folder selection as source connections, including the Drive folder picker endpoint; verify tests that each connection is stored with its config and the Drive picker lists only folders
- [ ] 5.3 Implement disconnect for every source kind: status update, file or secret deletion, exclusion from the next build; verify a test that disconnects a resume, confirms the file is gone, and confirms a build no longer reads it

## 6. Profile build, survey and review

- [ ] 6.1 Define the profile document zod schema in `packages/shared` with provenance on entries and a `flags` array; verify schema tests accept a full fixture document and reject an entry without sources
- [ ] 6.2 Implement the `profile.build` worker job: gather source texts, one Anthropic structured-output call (`claude-opus-5-5`, adaptive thinking, streaming), post-validation that every employer appears in source text, partial-source and conflict flagging, new version insert, activity log entry; verify tests with a recorded model response cover a clean build, a partial LinkedIn source, a date conflict producing a flag, and an invented employer being rejected
- [ ] 6.3 Implement the survey page and endpoint with required-field validation, daily target bounds (1 to 30, default 12) and new-version-on-revise; verify tests for the completed, missing-field, default-target and out-of-range scenarios
- [ ] 6.4 Implement the review page: editable sections, flagged items list, save-as-new-version, explicit approve storing `approved_profile_version` and timestamp, approve refused while conflicts are unresolved; verify e2e Playwright test that edits a field, resolves a flag, approves, and sees the approval time
- [ ] 6.5 Implement `requireApprovedProfile` and the pending-review state after a rebuild; verify tests that a job for an unapproved user exits with a `profile_not_approved` log entry and that a rebuild leaves the approved version in use

## 7. Integration check

- [ ] 7.1 Run the full onboarding path end to end in the running app with a test Google account: sign in, upload resume, add GitHub, complete survey, build, review, approve, in under 10 minutes; verify by recording the elapsed time and the activity log entries produced
- [ ] 7.2 Seed two tenants and run the tenancy and vault integration suites against both; verify no cross-tenant row, secret or log entry is visible in either direction
