# Wave 1 review findings (Codex, 2026-11-07) and dispositions

All 24 findings accepted for the fix pass. Adjustment: year-only dates are allowed in the profile schema (`YYYY` or `YYYY-MM` or null) instead of asking the model to invent months. Decision on P1 account matching: match by Google subject only; an unknown subject with an already-stored email redirects to `/signin?error=account_conflict` and creates nothing.

Static review found account-linking and approval-gate vulnerabilities, unbounded upload buffering, and a missing worker startup safeguard. Concurrent builds, profile writes, connection updates, and vault rotation also have correctness races, alongside reproducible OAuth and review-UI failures.

Full review comments:

- [P1] Authenticate existing accounts by Google subject, not email — /home/hdx/code/weapons-of-mass-application/packages/db/drizzle/0001_rls_roles.sql:47-47
  If Google returns a different subject with an email already stored, such as a recycled Workspace address, this lookup authenticates the existing tenant. The callback then issues a session for that tenant and can replace its vaulted refresh token. Match existing accounts by the stable Google subject; an email collision should require explicit account linking rather than grant access automatically.

- [P1] Bind approval to the version the user actually reviewed — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/review.ts:90-92
  If a rebuild completes after the review page loads but before Approve is submitted, this lookup selects and approves the new version without the user seeing it. The web app also permits approval while rebuilding, making this race reachable in one tab. Include the reviewed version in the approval request and reject a mismatch, preserving the requirement that rebuilt versions await explicit approval ([tenancy brief](docs/design/wave1-tenancy.md#L19)).

- [P1] Bound multipart bodies before buffering them — /home/hdx/code/weapons-of-mass-application/apps/api/src/routes/sources.ts:54-56
  A chunked request without Content-Length bypasses the preliminary size check, and parseBody buffers the entire multipart body before file.size is checked. An authenticated caller can therefore exhaust API memory with an arbitrarily large file or additional form fields despite the upload limit. Enforce an actual streamed request-body limit before multipart parsing.

- [P1] Validate the worker's vault key before starting consumers — /home/hdx/code/weapons-of-mass-application/apps/worker/src/main.ts:8-11
  With valid LLM configuration but a missing or malformed VAULT_MASTER_KEY, the worker starts consuming jobs instead of exiting. Drive credential errors can then be swallowed as partial-source failures, allowing builds to complete under invalid vault configuration. Call assertVaultConfigured before starting pg-boss, as required by the [vault startup rule](docs/design/wave1-vault.md#L10). The existing subprocess test checks only a fixture, not this entrypoint.

- [P2] Preserve Drive selections when synchronizing granted scopes — /home/hdx/code/weapons-of-mass-application/apps/api/src/auth/connections.ts:18-20
  Every successful returning sign-in sets the connected Drive row's config to an empty object, deleting its folder_ids and selected folder names. Subsequent profile builds silently stop collecting Drive documents until the user selects folders again. Update scope-related metadata without replacing the source configuration.

- [P2] Force consent from the Google reconnect link — /home/hdx/code/weapons-of-mass-application/apps/web/src/pages/ConnectionsPage.tsx:124-124
  Returning browsers have wma_known, but this reconnect link omits reconnect=1, so the authorization route does not force consent. When Google omits a new refresh token, the callback retains the expired or revoked token while marking the connections connected again. Point this link at the explicit reconnect flow so reconnecting can actually repair credentials.

- [P2] Keep the local OAuth callback on the web origin — /home/hdx/code/weapons-of-mass-application/packages/google/src/config.ts:33-34
  In the documented local setup, the web app runs on port 5173 but this default sends the callback to port 3000. Its success redirect to / and failure redirect to /signin therefore land on the API server, which serves neither page and returns 404. Use a callback through the web proxy or configure an explicit web-origin redirect, updating the registered redirect URI accordingly.

- [P2] Atomically reserve the user's in-flight build — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/builds.ts:31-39
  Two simultaneous build requests can both observe no running build and each insert and enqueue a separate build. The queue's singletonKey is the newly generated build ID, so it does not deduplicate these requests. This causes duplicate LLM calls, competing versions, and misleading latest-build status. Serialize the check-and-create operation per user or enforce the reservation with a database constraint.

- [P2] Verify or cancel stale jobs before enqueueing replacements — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/builds.ts:35-41
  A build older than fifteen minutes is treated as replaceable even if it is still queued or executing. The old pg-boss job is neither inspected nor cancelled, so requesting another build can leave both jobs running and publishing versions, potentially in reverse request order. Age alone should not release the single-flight reservation; confirm termination or fence the superseded job before replacing it.

- [P2] Serialize profile version allocation per user — /home/hdx/code/weapons-of-mass-application/packages/db/src/repos/profiles.ts:24-24
  Concurrent builds, survey saves, or profile edits can evaluate this subquery against the same committed maximum. Both then attempt the same version, and one fails the unique constraint instead of saving successfully. A surrounding transaction does not prevent this at READ COMMITTED isolation. Lock a stable per-user row before allocating the next version, preserving the [max-plus-one invariant](docs/design/wave1-profile-build.md#L17).

- [P2] Carry user-authored sections forward atomically with insertion — /home/hdx/code/weapons-of-mass-application/apps/worker/src/profile/build.ts:160-163
  If a survey save commits after carriedSections reads the latest profile but before this insertion, the build receives a newer version number while restoring the old survey, preferences, and standard answers. Both operations can succeed, so version-allocation locking alone does not fix the lost update. Read the carried sections and insert the completed document within the same serialized per-user transaction.

- [P2] Commit build output, terminal status, and activity together — /home/hdx/code/weapons-of-mass-application/apps/worker/src/jobs/profile-build.ts:24-26
  runProfileBuild commits the profile before the status update and activity entry. A subsequent failure can leave a new profile behind while the catch block marks its build failed; a crash can leave the profile committed with a running build and no profile_built event. Persist the completed profile, build outcome, and required activity entry in one transaction after model processing ([build rules 8–10](docs/design/wave1-profile-build.md#L17-L19)).

- [P2] Enforce source-connection uniqueness in the database — /home/hdx/code/weapons-of-mass-application/packages/db/src/repos/source_connections.ts:79-80
  Concurrent first connections can both pass this lookup and insert rows because source_connections has no unique constraint on tenant, user, and kind. getConnection subsequently returns an arbitrary duplicate, and disconnectConnection updates only that row, leaving another active connection available to builds after disconnection. Add the uniqueness constraint and use an atomic upsert in both connection-writing paths.

- [P2] Isolate concurrent resume replacements — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/resume.ts:83-85
  Two uploads for the same user write the same temporary pathname. One can rename it while the other is writing, causing corrupted replacement bytes or an ENOENT on the second rename. Shared final paths also race with format replacement and disconnection, allowing stored files and cached connection text to disagree. Serialize the complete per-user mutation or use immutable unique file references with coordinated metadata updates.

- [P2] Lock the secret before reading it for rotation — /home/hdx/code/weapons-of-mass-application/packages/db/src/vault/index.ts:189-192
  Rotation reads plaintext without locking the secret row. If put commits a replacement before rotation's UPDATE, rotation writes the old plaintext back over the new credential. A concurrent delete can also make the UPDATE affect zero rows while rotation still reports success and logs it. Lock the row within this transaction before decrypting and verify that the update succeeds.

- [P2] Exclude partial-source flags from the web approval gate — /home/hdx/code/weapons-of-mass-application/apps/web/src/pages/ProfileReviewPage.tsx:293-294
  This considers every unresolved flag blocking, so a normal partial LinkedIn or Drive source disables Approve even though the API permits approval. The browser should use the shared blocking-flag helper rather than require dismissal of informational flags. The [build brief explicitly says partial_source does not block](docs/design/wave1-profile-build.md#L18); the web mock currently reproduces the same incorrect all-flags gate.

- [P2] Allow conflict resolution after either conflicting entry changes — /home/hdx/code/weapons-of-mass-application/apps/web/src/pages/ProfileReviewPage.tsx:300-303
  Worker-generated date_conflict flags point only to the first entry. If the user follows the message and removes the second, incorrect entry, the first entry remains unchanged and this predicate permanently disables Resolve, including after saving. Track both conflicting entries or otherwise recognize removal of either one; resolving the actual conflict must allow approval.

- [P2] Require removal of blocking flags before approval — /home/hdx/code/weapons-of-mass-application/packages/shared/src/profile.ts:154-156
  A caller can keep an unsupported_entry or date_conflict in the document, set resolved to true through PUT /api/profile, and pass approval. The API test explicitly blesses this behavior, but the ground-truth definition says resolution means removing the flag through editing. Check for remaining blocking flags regardless of this boolean and update the contradictory test ([approval rule](docs/design/wave1-profile-build.md#L18)).

- [P2] Preserve readable Drive files when another file fails — /home/hdx/code/weapons-of-mass-application/apps/worker/src/drive.ts:34-40
  If one file export or download fails after earlier files succeeded, collectFiles throws and discards every collected document. gatherBundle then substitutes one empty Drive source, losing valid evidence from all readable files and subsequent folders. Handle failures per file and retain successful results, emitting a partial source for the failed file as required by [per-source failure handling](docs/design/wave1-profile-build.md#L25).

- [P2] Measure exported Drive content in bytes — /home/hdx/code/weapons-of-mass-application/apps/worker/src/drive.ts:41-42
  String.length counts UTF-16 code units, not UTF-8 bytes. A Google Doc export containing multibyte text can exceed the promised 2 MB limit while passing this check, especially where metadata supplies no usable size. Check encoded byte length and preferably bound the response while downloading, rather than buffering an unrestricted export ([Drive input limit](docs/design/wave1-profile-build.md#L5)).

- [P2] Flag a selected Drive source that yields no usable files — /home/hdx/code/weapons-of-mass-application/apps/worker/src/profile/bundle.ts:81-82
  When selected folders are empty, contain only unsupported files, or have every file skipped for size, collectFiles returns an empty array and no source is added. Post-validation consequently emits no partial_source flag, making unavailable Drive input disappear silently. Add an empty partial Drive source for this outcome, matching the [no-text source rule](docs/design/wave1-profile-build.md#L16).

- [P2] Leave unstated months unknown instead of inventing them — /home/hdx/code/weapons-of-mass-application/packages/llm/prompts/profile-build/v1.md:6-6
  For a source that states only a year, this instruction manufactures January and December dates that the evidence never supplied. Those invented months survive schema and post-validation and can alter employment durations and overlap flags. Preserve unknown dates rather than synthesize month precision, consistent with the [never-invent purpose](docs/design/wave1-profile-build.md#L3).

- [P2] Preserve timestamp precision in activity pagination — /home/hdx/code/weapons-of-mass-application/packages/db/src/activity/index.ts:95-98
  Postgres stores clock_timestamp with microsecond precision, but pg converts at to a JavaScript Date with millisecond precision. Passing the last returned at as before therefore skips older entries within that same millisecond. Timestamp-only pagination also cannot traverse ties despite ordering by ID. Use a precision-preserving timestamp-and-ID cursor for both activity listing functions.

- [P2] Seed each table before testing raw-SQL tenant isolation — /home/hdx/code/weapons-of-mass-application/packages/db/test/tenancy.test.ts:157-159
  Several tables, including source_connections, secrets, and vault_keys, have no rows when this loop runs, so their assertions pass vacuously. An incorrectly permissive SELECT policy on those tables can pass this test and the policy-count test; repository tests still filter tenant IDs themselves. Seed distinguishable rows for both tenants in every table and assert exactly the requesting tenant's rows are returned, exercising the [forgotten-filter backstop](docs/design/wave1-tenancy.md#L31).
