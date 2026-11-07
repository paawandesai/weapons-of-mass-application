# Wave 2 review findings (Codex, 2026-11-07) and dispositions

Two read-only Codex reviews (discovery half, submission half). All findings accepted. Added from agent self-reports: (a) move the board resolver and HTTP client out of apps/worker into a shared package so the API no longer imports worker source; (b) map work-authorization and sponsorship booleans onto Yes/No selects by meaning, never by passing free text; (c) a global test guard (msw onUnhandledRequest: error) in every package so no test can reach the real network. Decisions: scheduler enumeration uses SECURITY DEFINER functions returning only (tenant_id, user_id, run_hour), consistent with the pre-tenant lookups; ats_credentials gains a registration status (registering|verified|rejected) so a crash mid-sign-up resumes with the vaulted password.

## Discovery half

The patch has scheduler/RLS incompatibilities, run-dispatch races, cross-tenant reference gaps, and discovery correctness failures. The cross-app import additionally couples API runtime resolution to worker source; a specific build failure cannot be established without the omitted build and packaging configuration.

Full review comments:

- [P1] Use a separate privileged connection for roster enumeration — /home/hdx/code/weapons-of-mass-application/apps/worker/src/jobs/daily-run.ts:59-67
  With the non-owner application credentials required by the tenancy brief, these queries cannot enumerate users: they run without `app.tenant_id` against forced-RLS tables and fail at `current_setting`. `ownerRoster()` nevertheless defaults to the same `DATABASE_URL` used by the application. Consequently, production scheduler ticks and nightly cleanup fail; the injected test rosters hide this. Use restricted SECURITY DEFINER enumeration functions or an explicitly separate privileged connection, without elevating the application connection.

- [P1] Keep failed manual dispatches retryable — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/discovery.ts:425-429
  If dispatch throws after the queued run is committed, subsequent manual triggers return that existing row without attempting dispatch again. A similar orphan occurs when `boss.send()` returns null while a previous failed run's queue job is still active: the producer discards that result and reports success. Queued rows are excluded from stale-run recovery, so the day can remain permanently reserved without executable work. Persist dispatch recovery or otherwise make unsuccessful dispatches retryable.

- [P1] Transition skipped runs with a compare-and-set — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/discovery.ts:408-413
  After this request reads a skipped run, a scheduled worker can claim and even finish that same row before this unconditional update executes. The request then resets the live or finished run to `running/queued`; dispatch can be suppressed by the worker's still-active singleton, stranding the row, or another execution can overwrite the completed run's counts and append candidates again. Make takeover conditional on the row still being `skipped_no_profile`, and return the winning state when that condition no longer holds.

- [P1] Enforce tenant ownership on parent foreign keys — /home/hdx/code/weapons-of-mass-application/packages/db/src/schema.ts:330-335
  RLS checks the child's `tenant_id`, but foreign-key existence checks bypass the parent's RLS. Thus `insertRunCandidates(B.handle, A.run.id, ...)` succeeds and creates a cross-tenant reference; deleting A's run then cascades into B's rows. The new `applications.run_id` and `activity_log.application_id` references have the same ownership gap. Use tenant-qualified parent references, as already done for application-to-job and CAPTCHA-to-application, to preserve the isolation promised by the [tenancy brief](docs/design/wave1-tenancy.md).

- [P1] Include structured posting facts in the judgment prompt — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/judge.ts:43-48
  Lever's `salaryRange` and `workplaceType`, and Ashby's compensation and `isRemote`, are retained only in `candidate.raw`. This renderer never sends them to the model. When those facts are absent from the description, apply-decision cannot evaluate the stated salary or remote constraints and records missing facts despite the source providing them. Render the relevant structured metadata alongside the description; the fixture judgments currently supply answers independently of what the prompt contains.

- [P1] Filter removed companies out of third-party discoveries — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/discover.ts:59-64
  Removal only prevents constructing a board fetch. HN and LinkedIn still return postings from that company's board, and this loop accepts them without consulting removed memberships. They can therefore be judged, selected and submitted despite the explicit removal override in the [daily-run brief](docs/design/wave2-daily-run.md). Pass removal information into discovery and filter matching third-party postings; the existing removal test checks only that the board endpoint was not fetched.

- [P1] Recover never-enqueued applications on the same day — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/handoff.ts:93-98
  A crash after the hand-off commit, or an enqueue failure, leaves attempt-zero pending applications. A same-day replacement run drops those postings as already applied, while this date filter also excludes their pending applications from delivery recovery. Thus retrying the run cannot recover committed work until a later day's run, which might never occur. Recover attempt-zero deliveries independently of the next-day restriction for actual submission retries, preferably through durable dispatch reconciliation.

- [P2] Create the submission queue with its deduplication policy — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/handoff.ts:22-25
  When the producer encounters a missing queue, it creates one with the default standard policy. A `singletonKey` alone does not provide outstanding-job exclusion on a standard pg-boss queue. Producer-first initialization can therefore leave a queue on which recovery enqueues create multiple outstanding jobs for the same application. Share the consumer's queue configuration and enforce it here rather than relying on the consumer having initialized the queue first.

- [P2] Preserve the region of Lever boards — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/boards.ts:56-58
  `parseBoardUrl` accepts `jobs.eu.lever.co`, but retains only ATS and slug. Both URL builders then unconditionally use the US Lever hosts. Adding an EU board consequently rewrites its public URL and discovery fetches `api.lever.co` instead of `api.eu.lever.co`, making a valid EU-only board unavailable or resolving the wrong board. Preserve the region through the stored board reference and endpoint construction.

- [P2] Recognize Greenhouse embedded application identifiers — /home/hdx/code/weapons-of-mass-application/packages/shared/src/jobs.ts:80-81
  A supported Greenhouse application URL such as `https://boards.greenhouse.io/embed/job_app?for=acme&token=12345` is not recognized by `parseAtsJobUrl`, and normalization strips both identifying parameters because only `gh_jid` is retained. HN consequently drops these legitimate ATS links, while URL fallback collapses different embedded applications onto `/embed/job_app`. Recognize the embedded shape and preserve or canonicalize its job identifier, as required by daily-run rule 4.

- [P2] Reconcile candidate selection after a hand-off conflict — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/run.ts:280-281
  Runs for different dates may overlap, for example a slow run across midnight and the next day's manual trigger. Both can pass already-applied filtering before either commits. Application uniqueness correctly prevents duplicate applications, but the losing run leaves its candidates `selected = true` while replacing `counts.selected` with the smaller number of newly inserted applications. This violates the selection/count invariant and misrepresents the run through the API. Serialize the relevant user work or reconcile candidate flags and counts with the hand-off result.

- [P2] Enforce unresolved-company uniqueness in the database — /home/hdx/code/weapons-of-mass-application/packages/db/src/repos/companies.ts:94-96
  The transaction does not serialize this lookup-and-insert sequence. Concurrent generations for different tenants can both find no unresolved row and insert the same case-insensitive name, because the only company uniqueness constraint covers resolved ATS boards. The shared cache then contains multiple identities for one unresolved company, and ID-based membership/removal behavior becomes inconsistent. Add a partial unique constraint on unresolved normalized names and handle its conflict.

- [P2] Exclude removed suggestions before resolving new company rows — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/company-list.ts:127-138
  Removed memberships are included in `existing`, but they are enforced only through the model's advisory 'do not repeat' instruction. If a removed unresolved company is suggested again after its retry window and now resolves, resolution creates a different company ID; `upsertUserCompany` then creates an active membership and effectively resurrects it. Filter suggestions against removal overrides before resolution rather than relying solely on conflicts against the old company ID.

- [P2] Validate UUID structure before querying PostgreSQL — /home/hdx/code/weapons-of-mass-application/apps/api/src/routes/runs.ts:31-34
  The character-class check accepts malformed UUIDs such as 36 `a` characters or 36 hyphens. Those reach the UUID comparison in PostgreSQL and produce a server error instead of the intended not-found response. The company DELETE route uses the same check and has the same failure. Use UUID parsing or a structurally complete UUID validator; the existing malformed-ID tests only exercise strings rejected by length.

- [P2] Hold HTTP concurrency permits through body consumption — /home/hdx/code/weapons-of-mass-application/apps/worker/src/discovery/http.ts:103-104
  `fetch()` resolves when response headers arrive, so this release happens before `json()`, LinkedIn's `res.text()`, or board probing consumes the body. With promptly returned headers and slowly streamed bodies, arbitrarily many board downloads can remain in flight despite the advertised per-host limit. Keep the permit through body consumption or cancellation. The concurrency test delays the response before headers and therefore misses this case.

- [P2] Store compensation amounts beyond signed 32-bit integers — /home/hdx/code/weapons-of-mass-application/packages/db/src/schema.ts:368-369
  Judgment accepts integer pay amounts in the posting's own currency and period, but PostgreSQL `integer` rejects values above 2,147,483,647. Legitimate annual compensation in currencies such as VND can exceed that limit. One such selected posting fails the entire hand-off transaction and rolls back every application in the run. Use a sufficiently wide numeric representation consistently with the shared judgment type.

- [P2] Make pending-delivery tests independent of the real date — /home/hdx/code/weapons-of-mass-application/apps/worker/test/discovery/run.test.ts:424-428
  The application is inserted with PostgreSQL's real `created_at`, but the two runs use fixed November 7–8, 2026 dates. These assertions pass only when the database's current UTC date is November 7: before then the supposed same-day run requeues the application, and on or after November 8 the supposed next-day run does not. Control the stored timestamp or derive both run dates from the creation date.

- [P2] Require the explicit smoke-test opt-in value — /home/hdx/code/weapons-of-mass-application/apps/worker/test/discovery/judge.smoke.test.ts:15-18
  The documented opt-in is `RUN_LLM_SMOKE=1`, but this truthiness check also enables the real model calls for `RUN_LLM_SMOKE=0` or `RUN_LLM_SMOKE=false`. A test environment using either conventional disabled value unexpectedly performs paid external requests, with MSW allowing them through. Compare against the explicit enabled value rather than merely checking whether the variable is nonempty.

- [P3] Assert the expected resolver calls independently of actual calls — /home/hdx/code/weapons-of-mass-application/apps/worker/test/discovery/company-list.test.ts:175-177
  Filtering the expected names through `calls.includes` makes an empty actual call list satisfy this assertion. In particular, a regression that stops retrying the unavailable Saltmarsh company for the second user still passes. Assert the independently expected calls directly; Copperline should use its unresolved cache window, while Saltmarsh should be retried.

- [P3] Measure prompt construction instead of comparing identical calls — /home/hdx/code/weapons-of-mass-application/apps/worker/test/discovery/judge.test.ts:143-145
  This assertion calls `buildSystem` twice and compares the resulting strings. It tests determinism, not the claimed once-per-profile construction, and still passes if `judgeAll` rebuilds the system prompt for every candidate. Exercise `judgeAll` and observe prompt loading or construction count so the intended regression actually fails.

- [P3] Inspect all tenant jobs when checking that skipped jobs are absent — /home/hdx/code/weapons-of-mass-application/apps/worker/test/discovery/run.test.ts:203-204
  `jobs` was fetched using only the job IDs of the four applications. Its length remains four even if discovery incorrectly persists every skipped posting as an additional job, so this assertion cannot verify the stated storage invariant. Query all jobs for the tenant, or explicitly check that skipped posting keys do not exist.

## Submission half

The pasted diff contains crash-recovery, credential-concurrency and secret-disclosure defects, plus incorrect email correlation and form resolution. CAPTCHA expiry and single-use behavior also have race conditions, and the truthfulness checks admit unsupported claims.

Full review comments:

- [P1] Remove raw exception messages from activity details — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/failure.ts:20-20
  When Playwright fails while filling a password or navigating to a verification link, its error message can contain the supplied password or token-bearing URL. Truncating that message does not sanitize it: `failAttempt` stores it in activity details, and the applications detail route returns those details verbatim. Record allowlisted error categories instead of raw browser messages.

- [P1] Serialize account creation by user, ATS and company — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/accounts/index.ts:94-102
  Two concurrent applications at the same company can both observe no credential, generate different passwords, and overwrite the same vault reference. Only one credential insert succeeds, but the losing attempt can already have overwritten the winning attempt's password. The remote account can therefore be created with a password different from the stored one. Serialize the entire account-creation operation on the credential key, not just the application ID.

- [P1] Persist and recover incomplete account registration — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/accounts/index.ts:102-106
  If the worker crashes after inserting the credential but before submitting sign-up, the next attempt treats that credential as an existing remote account and attempts sign-in. The account does not exist, so rejection permanently marks the credential unusable and prevents registration from completing. Persist a registration lifecycle and resume incomplete creation using the already-vaulted password rather than treating every credential row as a completed account.

- [P1] Reconcile uncertain submissions before resubmitting — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/job.ts:275-281
  After a crash following the ATS submit click but before `markApplied`, the only recovery check is one immediate Gmail search. If confirmation is delayed or only available on the vendor page, the attempt proceeds through tailoring and submits again; there is no prior-page confirmation check before filling or submitting. Reconcile the persisted `submitting` evidence, including vendor confirmation, before allowing another submit.

- [P1] Correlate confirmation emails with the specific application — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/confirmation.ts:14-18
  For concurrent applications with the same title at different companies using the same ATS, both searches include the vendor-wide sender domain and accept the same confirmation message. One successful application can therefore mark another unsuccessful application as applied, including through the prior-confirmation path. Require application/company-specific evidence rather than sender domain, time and title alone.

- [P1] Validate sender domains after retrieving Gmail messages — /home/hdx/code/weapons-of-mass-application/packages/../apps/worker/src/submission/gmail.ts:66-66
  Gmail's `from:` search is not an exact parsed-mailbox domain check; an unrelated sender can match the domain text in an address or display name. This implementation only post-filters timestamps, unlike `MemoryGmail`, which enforces domain boundaries. Consequently unrelated mail can supply a verification URL/code or confirmation. Parse the actual sender address and require an allowed domain or subdomain before returning messages.

- [P1] Preserve retries for failures without a recorded outcome — /home/hdx/code/weapons-of-mass-application/apps/worker/src/jobs/submit-application.ts:37-40
  Failures before or during durable failure recording can escape `runSubmission`, such as a database outage or profile-loading failure. Catching them here and returning successfully acknowledges the pg-boss job without recording a pending reason or incrementing `attempt_count`. An initial application can remain pending at count zero, outside the specified daily retry path. Propagate infrastructure failures for queue retry unless an application outcome was successfully committed.

- [P1] Preserve the polarity of authorization questions — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/answers/classify.ts:48-51
  The sponsorship rule runs before work authorization and matches every occurrence of `sponsor`. Thus the explicitly tested label “Are you authorized to work in the US without sponsorship?” receives the sponsorship-required flag: a user who does not require sponsorship gets “No” instead of “Yes.” Distinguish questions asking whether sponsorship is required from questions asking whether the applicant can work without it.

- [P1] Match verification mail to the account being registered — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/accounts/verification.ts:40-46
  When two companies on the same ATS send verification messages after sign-up starts, this loop takes the earliest extractable link or code regardless of company, account or thread. The second application can consume the first company's verification message and subsequently mark its own unverified credential rejected. Correlate verification evidence to the registration instead of accepting any recent vendor-domain message.

- [P2] Make follow-up scheduling recoverable after marking applied — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/job.ts:189-195
  The applied transition commits before follow-up enqueueing. A crash in that gap, or the caught enqueue failure, permanently loses the required follow-up because future submission jobs exit immediately for applied rows. Queue-level deduplication prevents duplicates but does not repair missing jobs; persist an outbox entry with the applied transition or provide a durable scheduling-recovery path.

- [P2] Commit form answers together with the fill activity — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/job.ts:319-322
  The form-answer state change commits in its own transaction, while `filled` is logged only after browser filling and attachment complete. A crash or fill error leaves committed answers without their corresponding step entry, violating the one-transaction-per-step requirement and making planned values appear as completed answers. Commit the answer patch and its activity entry together, still before submission.

- [P2] Await failure recording before closing the browser context — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/job.ts:343-346
  Returning the `failAttempt` promise without awaiting it causes `finally` to run while failure recording is suspended on `page.screenshot()`. The context is therefore closed concurrently with screenshot capture, which can destroy the page and silently omit the required failure screenshot. Await failure handling in both catch branches before entering cleanup.

- [P2] Reject dates that the truthfulness checker cannot parse — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/tailor/facts.ts:133-136
  Generated dates accept arbitrary strings, but an unparseable date becomes `null` and bypasses the range checks. For example, an invented out-of-range ISO day date such as `2010-01-01` is printed unchanged yet is not checked by either comparison pass. Validate supported date syntax and month bounds, and fail closed when a nonempty date cannot be interpreted.

- [P2] Reject reversed employment date ranges — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/tailor/facts.ts:145-146
  Only a start before the profile start and an end after the profile end are rejected. A role with profile dates 2018–2021 therefore accepts resume dates 2030–2019: the start passes its lower-bound check and the end passes its upper-bound check. Check range ordering and both endpoints against the permitted interval before accepting the resume.

- [P2] Include the printed education field in deterministic checks — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/tailor/facts.ts:183-183
  The PDF prints both `degree` and `field`, but the deterministic facts omit `field`. A generated `BSc` in an invented subject passes whenever the extractor returns only `BSc`, which its schema permits. Include and validate the structured education field so an extractor omission cannot approve a degree claim different from the profile.

- [P2] Require evidence of holding a claimed certification — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/tailor/facts.ts:163-167
  Substring presence in flattened profile prose does not establish a certification. A profile saying “Studying for AWS Solutions Architect” or “Not AWS Solutions Architect certified” causes that certification claim to pass this check. Compare against positively established certification facts rather than arbitrary occurrences in summaries, skills and project text.

- [P2] Resolve grouped checkboxes to option arrays — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/answers/freetext.ts:72-78
  All checkbox answers become a boolean, even when the field has multiple options. `fillOne` expects option strings for such groups, so `true` becomes the choice `"true"` and normally leaves every real option unchecked. This affects the Ashby `q-stack` fixture and prevents correctly resolving required multi-select questions. Validate selected options and return a string array for grouped checkboxes.

- [P2] Attach the resume before advancing past its required step — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/adapters/ashby.ts:84-86
  For an Ashby form whose earlier step requires a resume, `fill()` tries to advance to subsequent steps before the job calls `attachResume()`. When Next validates required fields, navigation fails with the adapter's “required field is empty” error, so a fully answerable application cannot reach submission. Upload the resume before advancing beyond its step.

- [P2] Use the shared browser for production PDF rendering — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/wiring.ts:15-15
  Production calls `tailorResume` without a browser, so every resume render launches its own Chromium process instead of using the worker's shared browser. Concurrent submissions can therefore run multiple browsers alongside the ATS browser, contrary to rule 16 and outside the fake-browser concurrency test's accounting. Wire PDF rendering through the shared browser.

- [P2] Check the human deadline before entering an answer — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/captcha/index.ts:199-205
  If an answer arrives just before expiry but polling resumes at or after the deadline, this branch enters it and can mark the CAPTCHA resolved before checking the clock. The browser can therefore continue beyond the required 900-second window. Check the deadline before processing an answer and bound browser operations by the remaining window.

- [P2] Evaluate CAPTCHA expiry after reading the request body — /home/hdx/code/weapons-of-mass-application/apps/api/src/routes/captcha.ts:74-79
  The expiry timestamp is captured before awaiting body parsing. A client can start a POST before expiry and finish sending its body afterward; if the worker is dead or has not marked the row expired, the atomic update still compares against the old timestamp and accepts the expired token. Evaluate current time at the write, preferably using the database clock for the expiry predicate.

- [P2] Recheck the token hash when loading the public challenge — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/captcha.ts:26-30
  Token resolution and request loading are separate queries, and the latter checks only request ID and openness. If the worker replaces the token between those queries, a GET using the consumed token can render the newly issued challenge instead of returning 410. Verify that the loaded row still carries the supplied token hash, or perform a single tenant-scoped lookup by hash.

- [P2] Serialize extension of the human-stage reservation — /home/hdx/code/weapons-of-mass-application/apps/worker/src/submission/captcha/index.ts:191-193
  The per-user reservation expires relative to the time before sending, but its expiry is later extended outside the reservation lock. If sending stalls or the worker is suspended beyond that initial expiry, another application can reserve the user's slot; when the first worker resumes, it extends its request and leaves two human requests open. Finalize the send-relative expiry under the same per-user serialization and verify ownership before extending.

- [P2] Stop manufacturing fresh challenge images in the fake — /home/hdx/code/weapons-of-mass-application/apps/worker/test/submission/support.ts:334-336
  Every screenshot appends an incrementing counter even though the underlying challenge has not changed. Consequently the reject-then-accept test's assertion that the resent image differs passes automatically, including when production only screenshots an unchanged challenge. Model challenge changes independently from screenshot calls so the required fresh-image behavior can actually fail its test.

## Left open after the fix pass

- Submission queue dedup policy: `SUBMIT_QUEUE_OPTIONS` sets retries and expiry but no pg-boss `policy`, so a job can be queued while a sibling for the same application is active. Harmless: the job claims the row under lock, finds it no longer pending, logs `duplicate_enqueue` and exits. Revisit if queue volume makes the wasted claim matter.
- Network guard is a socket-level patch rather than a global msw server, because a second msw server stacked with per-test servers broke the per-host concurrency test.
