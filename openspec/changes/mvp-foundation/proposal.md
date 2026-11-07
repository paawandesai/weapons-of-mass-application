# Proposal

## Why

Nothing can run until a user can sign in, connect their sources, and approve a profile the agent built from them: every later change (discovery, applying, inbox, dashboard) reads the profile and writes to the activity log and vault this change creates. The hackathon demo opens on this flow, so it has to exist first and be trustworthy.

## What Changes

- Google OAuth sign-in that creates a tenant and user on first login and stores the granted Google tokens (Gmail read/send, Calendar read/write, Drive read) encrypted per tenant. Implements PRD §4 (Sign-in), §7.1, A13.
- Source connections a user can add and remove: resume upload, LinkedIn public profile URL, GitHub username, Google Drive folder selection. Disconnecting a source stops further reads. Implements PRD §7.1, §10.
- Profile build: the agent assembles one master profile document from connected sources and stores it with a version. Implements PRD §7.1, §8 (profiles).
- Onboarding survey: a single page of preferences (target roles, salary floor, locations and remote preference, work-life balance, family constraints, relocation, career direction, daily application target) stored on the profile. Implements PRD §6 step 3, §7.1.
- Profile review gate: the user edits and approves the profile; nothing downstream may act for a user until approval. Implements PRD §7.1, §10.
- Activity log: every action taken on a user's behalf is recorded with actor, action and detail, and is readable per application and per user. Implements PRD §8 (activity_log), §10.
- Credential vault: encrypted storage for Google tokens and, later, ATS passwords, with a per-tenant data key wrapped by a master key. Implements PRD §8 (ats_credentials), §9 (Secrets), A6.
- Tenant isolation: every row carries a tenant id and every read is scoped to the caller's tenant. Implements PRD §4 (Tenancy), §13.
- Repository scaffold: pnpm monorepo, Postgres migrations for users, profiles, activity_log and vault tables, local dev setup.

**Out of scope for this change:** job discovery and the decision engine, resume tailoring and application submission, ATS account creation (the vault is built here; the accounts come later), inbox sync and scheduling, notifications, the kanban dashboard, the simulated recruiter, and the interviewer-facing feedback page.

## Capabilities

### New Capabilities
- `tenancy`: every record belongs to exactly one tenant and no request can read or write across tenants.
- `google-sign-in`: sign-in with Google that creates the tenant and user, captures the Gmail, Calendar and Drive grants, and keeps the session.
- `profile`: the master profile document built from connected sources, its versioning, and the sources a user can connect or disconnect.
- `onboarding-survey`: the preferences survey whose answers are stored on the profile and set the daily application target.
- `profile-review`: the user's one-time review, edit and approval of the profile, which gates every downstream action.
- `activity-log`: the per-user, per-application audit trail of what the agent did.
- `credential-vault`: encrypted-at-rest storage of Google tokens and ATS credentials with per-tenant keys.

### Modified Capabilities
(none: this is the first change)

## Impact

- New monorepo: `apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/llm`, `packages/shared`.
- New Postgres tables: `tenants`, `users`, `profiles`, `source_connections`, `activity_log`, `vault_keys`, `secrets`.
- New external dependencies: Google OAuth client and Google APIs (Gmail, Calendar, Drive), Anthropic SDK for profile synthesis, Playwright is not needed yet.
- Environment: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `DATABASE_URL`, `VAULT_MASTER_KEY`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`.
- Every later change depends on the profile document shape, the activity log API and the vault API defined here.
