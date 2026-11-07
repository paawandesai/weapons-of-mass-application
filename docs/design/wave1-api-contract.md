# Wave 1 API contract (apps/api <-> apps/web)

All `/api/*` routes require a session cookie; unauthenticated requests get 401 `{code: "unauthenticated"}`. Errors are `{code, message}`; validation errors are 400 `{code: "validation", issues: [...]}`.

Auth
- `GET /auth/google/start` -> 302 to Google (PKCE, offline, consent).
- `GET /auth/google/start?reconnect=1` -> same, but always forces the consent screen so Google issues a new refresh token (the Connections page "Reconnect with Google" link).
- `GET /auth/google/callback?code&state` -> sets session cookie, 302 to `<WEB_ORIGIN>/` on success; 302 to `<WEB_ORIGIN>/signin?error=<code>` on failure (`unverified_email`, `declined`, `oauth_error`, `account_conflict`). `WEB_ORIGIN` defaults to `http://localhost:5173`. An existing account is matched by Google subject only; a new subject whose email is already stored fails with `account_conflict` and nothing is created or linked.
- `POST /auth/signout` -> 204, cookie cleared, session row deleted.

Me and connections
- `GET /api/me` -> `{user: {id, email, display_name, approved_profile_version, approved_profile_at, daily_target, digest_hour}, connections: [{kind, status, config, connected_at}]}` where kind is `resume|linkedin|github|drive|gmail|calendar` and status `connected|disconnected|partial`. `config` never includes the cached source `text`. Config keys by kind: resume `filename, format, size`; linkedin `url, fetch, fetched_at`; github `username, repos, fetched_at`; drive `folder_ids, folders` (or `missing_scopes` when the scope is missing); gmail and calendar `missing_scopes` when missing.

Sources
- `POST /api/sources/resume` multipart field `file` (PDF or DOCX, max 10 MB) -> 201 `{connection}`; 400 `unsupported_type` or `too_large`. The request body is limited while it streams (10 MB plus multipart framing), so a chunked upload without Content-Length is cut off with `too_large` too.
- `POST /api/sources/linkedin` `{url}` -> 201 `{connection}`.
- `POST /api/sources/github` `{username}` -> 201 `{connection}`.
- `GET /api/sources/drive/folders` -> `{folders: [{id, name}]}` (only folders); 409 `drive_not_connected` if the Drive scope is missing.
- `POST /api/sources/drive` `{folder_ids: string[]}` -> 201 `{connection}`.
- `DELETE /api/sources/:kind` -> 204 (file or config removed, status disconnected).

Profile
- `POST /api/profile/build` -> 202 `{job_id}`; 409 `no_resume` if no resume connected. At most one build per user runs at a time (database-enforced); a request while one runs returns that build's id.
- `GET /api/profile/build/status` -> `{state: "idle"|"running"|"done"|"failed", version?, reason?}`.
- `GET /api/profile` -> `{version, document, approved_version, approved_at, flags}` or 404 `no_profile`.
- `PUT /api/profile` `{document}` -> 200 `{version}` (new version, validated against the shared zod schema).
- `POST /api/profile/approve` `{version}` (the version the user reviewed) -> 200 `{approved_version, approved_at}`; 409 `version_mismatch` with `{latest_version}` when `version` is not the latest (a rebuild or edit landed meanwhile; nothing is approved); 409 `unresolved_flags` with `{flags}` while any `unsupported_entry` or `date_conflict` flag is still present in `flags[]` (the `resolved` boolean is ignored; resolving means removing the flag; `partial_source` never blocks); 404 `no_profile`. A missing or non-integer `version` is 400 `validation`.

Survey
- `GET /api/survey` -> `{answers | null}`.
- `PUT /api/survey` `{answers}` -> 200 `{version}` (writes a new profile version with the survey section; creates version 1 with an empty document if none exists).

Shapes come from `@wma/shared` (`ProfileDocument`, `SurveyAnswers`, `Connection`, `MeResponse`). The web app imports those types; it never redefines them.
