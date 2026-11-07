# Wave 4 review findings (Codex, 2026-11-07) and dispositions

One read-only Codex review. All 15 findings accepted. Added from agent self-reports and the demo plan: (a) a `seeded` discovery source for demo tenants so the daily run finds the seeded jobs, plus submission adapter routing for forms-server URLs (/forms/<vendor>/...), so a live run applies to them; (b) a demo inbox page (web, demo tenants only, backed by GET /api/admin/demo-mailbox) so the audience can open the slot-confirmation and CAPTCHA links that land in the simulated mailbox; (c) email_threads gains a subject column written at sync time so card detail shows subjects for real tenants without touching demo tables. Decision: follow-on work (prep plan after booking, negotiation after offer, mail sync after simulated delivery) is persisted as rows in a small `pending_jobs` outbox inside the parent transaction and dispatched by a reconciler, instead of enqueue-after-commit.

The pasted changes contain durable-handoff gaps, a mailbox cursor race, ineffective queue deduplication, and missing automatic Offer handling. The rehearsal can also mutate a production-configured database and report success while skipping core acceptance scenarios.

Full review comments:

- [P1] Check production mode after loading the rehearsal environment — /home/hdx/code/weapons-of-mass-application/scripts/demo-rehearsal.sh:53-57
  If `.env` sets `NODE_ENV=production` but the invoking shell does not, this check passes before `.env` is sourced. The script then migrates and seeds the production-configured database before eventually failing demo sign-in. Load the environment before checking production mode, so the refusal happens before any database mutations.

- [P2] Keep real card reads out of the demo mailbox — /home/hdx/code/weapons-of-mass-application/apps/api/src/routes/applications.ts:214-218
  For every real tenant with linked Gmail threads, card detail unconditionally calls `listDemoThread`. This bypasses the demo flag boundary, and because real mail is not stored in that table, every real thread's subject is returned as null. Resolve subjects through normal thread metadata and consult the simulated mailbox only for flagged demo tenants.

- [P2] Read demo message IDs and their watermark consistently — /home/hdx/code/weapons-of-mass-application/apps/worker/src/demo/ports.ts:68-69
  If a recruiter message commits after `listDemoMessagesAfterHistory` finishes but before `currentDemoHistoryId` runs, this response omits that message while advancing the history watermark past it. Subsequent syncs will never retrieve it. Derive the IDs and watermark from the same snapshot or advance only through history actually examined.

- [P2] Make prep-plan enqueueing durable with the pending state — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/prep.ts:149-155
  A process crash after this transaction commits but before `enqueuePrepPlan` runs leaves the interview pending without any queued job. Every subsequent request returns the pending no-op, so the user cannot recover it. Persist the queue handoff transactionally, or provide reconciliation for pending interviews without outstanding work.

- [P2] Preserve delivery retries for interrupted prep-plan jobs — /home/hdx/code/weapons-of-mass-application/apps/worker/src/jobs/prep-plan.ts:23-25
  For booking-triggered plans, `retryLimit: 0` prevents redelivery when the worker dies after setting `prepPlanStatus` to pending. The generator's internal retry only handles caught failures; it cannot recover a terminated process. Once the queue job fails or expires, the pending API guard also prevents a replacement request, leaving the plan stuck indefinitely.

- [P2] Configure exclusive policies for the keyed worker queues — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/prep.ts:41-46
  These queues are created with the default standard policy, where `singletonKey` alone does not enforce one queued-or-running job. The worker registrations likewise omit a policy. Concurrent negotiation requests, or a booking enqueue overlapping an on-demand prep request, can therefore execute duplicate jobs and overwrite each other's results. Configure keyed exclusivity consistently in both API and worker queue creation.

- [P2] Persist automatic follow-on work before committing its trigger — /home/hdx/code/weapons-of-mass-application/apps/worker/src/inbox/sync.ts:343-343
  A crash after the inbox transaction commits but before this enqueue permanently loses the automatic negotiation job: reprocessing an application already in Offer cannot set `movedToOffer` again. The new prep hook in `scheduling/book.ts` has the analogous gap after booking is committed. Record durable follow-on work with each parent transaction, then dispatch it separately without undoing the card transition or booking.

- [P2] Recover mailbox sync scheduling after recruiter delivery — /home/hdx/code/weapons-of-mass-application/apps/worker/src/jobs/simulated-recruiter.ts:39-41
  If the worker crashes or `boss.send` fails after simulated mail is committed, the next pass finds the deterministic message IDs and reports no new deliveries. This condition then suppresses the missing sync permanently until an unrelated hourly or manual sync occurs. Reconcile unread mailbox work or persist a durable sync request alongside delivery instead of relying only on this pass's delivery count.

- [P2] Commit the seeded run and its candidates together — /home/hdx/code/weapons-of-mass-application/packages/db/src/seed/demo.ts:225-227
  The marked run is committed before candidate insertion. If insertion fails or the seed process stops here, the next seed invocation sees `counts.seeded` and returns without repairing the missing candidates. Consequently, an interrupted seed cannot complete itself and leaves a finished run with incomplete data. Insert the run and candidates in one transaction or reconcile candidates by natural key.

- [P2] Enqueue negotiation for user-driven Offer transitions — /home/hdx/code/weapons-of-mass-application/apps/api/src/routes/applications.ts:297-297
  Moving a card into Offer through the board returns success without scheduling negotiation. Only inbox-driven transitions invoke the automatic enqueue, so manually moved Offer cards never receive the required posted range, floor, or comparables unless the user discovers and presses the separate Gather pay data button. Trigger the pay-data job for successful user transitions into Offer as well.

- [P2] Serialize run polling before advancing the cursor — /home/hdx/code/weapons-of-mass-application/apps/web/src/pages/RunViewPage.tsx:74-77
  When a request or multi-page drain takes longer than five seconds, the interval starts another poll using the same cursor. Both responses append their candidates, producing duplicate rows and potentially moving the cursor backward when responses arrive out of order. Allow only one poll/drain at a time, or schedule the next poll after the current one completes.

- [P2] Provision mandatory e2e scenarios instead of skipping them — /home/hdx/code/weapons-of-mass-application/apps/web/e2e/board.spec.ts:11-12
  A fresh `seedDemo` deliberately creates no applications or interviews and only a finished run. The rehearsal does not provision the missing scenarios before running e2e, while these skips and the equivalent feedback/prep/offer/run skips allow the required acceptance tests to disappear from a green rehearsal. Create deterministic application, interview, offer, and running-run fixtures during setup, and fail when required fixtures or API reads are missing.

- [P2] Fail the browser fetch test when Chromium cannot start — /home/hdx/code/weapons-of-mass-application/apps/worker/test/negotiation/negotiation.test.ts:154-155
  Browser launch failures are converted to null in setup, and this return then marks the Playwright fetch test as passed without executing any assertions. A missing browser installation or broken Chromium launch therefore leaves the new production fetch path completely untested while reporting success. Require a working browser for this test rather than silently returning.

- [P2] Bound company-search work in the database — /home/hdx/code/weapons-of-mass-application/apps/api/src/services/board.ts:108-111
  For users with a large application history, every search loads all applications, full associated job rows, and companies before filtering and sorting in memory. Slicing to 20 afterward bounds the response but not database transfer or API memory, and this work repeats as the user types. Apply the tenant/user-scoped company-name predicate and result limit in the database instead.

- [P2] Align seeded posting URLs with the configured forms port — /home/hdx/code/weapons-of-mass-application/packages/db/src/seed/catalog.ts:6-7
  The rehearsal exposes `--forms-port` and `DEMO_FORMS_PORT`, but seeded posting URLs always use port 4310. Running the supported rehearsal with another forms port starts a healthy fixture server while every seeded application URL still targets the wrong listener. Pass the configured origin into seeding, or reject unsupported port overrides.
