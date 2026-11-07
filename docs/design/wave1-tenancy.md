# Design brief: tenant scoping and the approval gate

Purpose: guarantee that no query, job or log read ever crosses tenants, with two independent layers, and that no agent work runs for a user without an approved profile. Read by every repository function and every pg-boss handler.

Inputs: `tenant_id` (uuid) resolved from the session row, never from the request body or headers; `user_id`; the Postgres connection.

Units: n/a.

Rules:
1. Every tenant table MUST have `tenant_id uuid not null` and an index starting with it.
2. `db.forTenant(tenantId)` MUST return a handle whose every query runs inside a transaction that first executes `set local app.tenant_id = $1`.
3. Every tenant table MUST have RLS enabled and forced (`FORCE ROW LEVEL SECURITY`) with policy `tenant_id = current_setting('app.tenant_id')::uuid` for select, insert, update, delete.
4. The application database role MUST NOT be a superuser or table owner, so RLS applies to it. Migrations run as the owner role.
5. Repository functions MUST take the handle, never a raw client, and MUST still add `where tenant_id = handle.tenantId` (layer one) even though RLS exists (layer two).
6. An insert whose row carries a different `tenant_id` than the handle MUST fail at the RLS policy; the repository MUST stamp `tenant_id` from the handle and ignore any caller-supplied value.
7. A read of another tenant's row by primary key MUST return `not_found`, indistinguishable from a nonexistent id.
8. `activity_log` MUST additionally revoke UPDATE and DELETE from the application role.
9. `requireApprovedProfile(handle, userId)` MUST return the approved profile version or throw `profile_not_approved`; every pg-boss handler MUST call it first and on throw write one activity log entry `profile_not_approved` and exit without doing work.
10. A rebuild of the profile MUST NOT change `users.approved_profile_version`; the new version waits for explicit approval.

Edge cases: a user with `approved_profile_version` set but that version row deleted is a bug, treat as not approved. The migration role seeing all rows is expected. Empty result from a forgotten `set local` is the RLS backstop working, not a data bug; tests assert it explicitly.

Time: n/a.

Failure handling: a missing `app.tenant_id` setting MUST make `current_setting` with `missing_ok = false` raise, which fails the query loudly rather than returning empty.

Consistency: handle-per-request; one transaction per repository call unless the caller opens one.

Outputs: `forTenant`, repository modules, `requireApprovedProfile`; integration test that sets tenant A and reads tenant B directly with SQL (bypassing repositories) and gets nothing.

Tests: rules 2, 3, 6, 7, 8, 9, 10 each; the forgotten-filter test (raw SQL under the handle, no where clause, sees only own tenant); the forged tenant id on insert; the deleted-approved-version edge case.

Out of scope: multiple users per tenant UI, role-based permissions, superuser tooling.

## Decision log

- 2026-11-07: Pre-tenant lookups (`resolveSession(sessionId)`, `findUserIdentity(googleSub, email)`) are SECURITY DEFINER SQL functions returning ids and expiry only, because a session or Google sub must be resolved before a handle exists and forced RLS blocks that. They rely on the migration owner being able to bypass RLS; a non-superuser production owner needs BYPASSRLS. Recorded as a launch task.
- 2026-11-07: `SET LOCAL` cannot take a bind parameter, so the handle validates a strict uuid regex and interpolates. Covered by an injection test.
- 2026-11-07: `users.approved_profile_at timestamptz null` is added by the profile review agent (task 6.4 needs it; the Migration Plan omitted it).
- 2026-11-07: `vault_keys` has `wrap_iv` and `wrap_tag` bytea columns in addition to `wrapped_dek`; the Migration Plan abbreviated them.
- 2026-11-07 (review fix): sign-in resolves an existing account by Google subject only (`findUserIdentity(googleSub)`); `emailExists(email)` is a second SECURITY DEFINER lookup returning a boolean. An unknown subject whose email is already stored redirects to `/signin?error=account_conflict` and creates nothing.
