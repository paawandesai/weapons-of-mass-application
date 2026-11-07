# Tasks

## 1. Schema and shared rules

- [ ] 1.1 Add Drizzle migrations for `email_threads`, `processed_messages`, `interviews`, `interview_slots`, `outgoing_messages`, `applications.followed_up_at`, `users.digest_hour`, `users.timezone`, all with `tenant_id`; verify `pnpm db:migrate` applies cleanly on an empty database and `pnpm db:migrate` again is a no-op
- [ ] 1.2 Implement `nextStatus(current, classification)` in `packages/shared` with forward-only transitions and the Closed sink; verify a Vitest table test covers every (status, classification) pair from the `inbox-sync` spec
- [ ] 1.3 Implement the outgoing content guard `checkOutgoing({subject, body})` in `packages/shared`; verify Vitest cases for `$`, each blocked word in mixed case, word-boundary false positives such as "equitable", and a clean message

## 2. Send path

- [ ] 2.1 Implement `sendEmail` in `apps/worker` wrapping the Gmail send API with the guard, `outgoing_messages` storage and activity-log rows for sends and blocks; verify a Vitest test with a mocked Gmail client shows a blocked message is stored with `blocked: true` and the Gmail client is never called
- [ ] 2.2 Add the employer-text scrubber used by user-facing templates; verify a test that a digest containing "$150k" from a recruiter renders "[omitted]" and passes the guard

## 3. Inbox sync

- [ ] 3.1 Implement the hourly `mail-sync` pg-boss job using Gmail `history.list` with the stored `historyId` and the dated `messages.list` fallback; verify a test with recorded Gmail fixtures that running the job twice processes each message once and advances the high-water mark only after commit
- [ ] 3.2 Implement deterministic thread linking (sender domain, then title) with LLM disambiguation only for zero-or-many candidates; verify Vitest cases for the four linking scenarios in the `inbox-sync` spec including the two-tenant isolation case
- [ ] 3.3 Add the versioned `inbox-classify` prompt with structured output `{classification, compensation_flag, booking_link, proposed_slots[]}` and store the prompt version on the thread row; verify a fixture test over one message per classification plus a compensation question and a booking link
- [ ] 3.4 Wire classification into status transitions and digest flags; verify an integration test on a seeded database that a rejection message closes the application with reason "rejected" and an interview message on a Closed application leaves it Closed and flags it
- [ ] 3.5 Handle invalid mailbox credentials by marking the connection as needing re-authorization and logging; verify a test with a 401 fixture that the high-water mark is unchanged and the user flag is set

## 4. Follow-ups

- [ ] 4.1 Enqueue a `follow-up` job at submission with `startAfter = applied_at + 7d` and singleton key per application (coordinate with `application-submission`: add the enqueue call at its submit-success point); verify a test that submitting twice does not enqueue twice
- [ ] 4.2 Implement the `follow-up` job with the re-checks (still Applied, no linked thread, no `followed_up_at`, contact known) and template generation through `sendEmail`; verify Vitest cases for each skip condition and one successful send that sets `followed_up_at`

## 5. Interview scheduling

- [ ] 5.1 Persist proposed slots from classification onto `interviews` and `interview_slots` in the user's time zone, dropping ambiguous options with a note; verify a test with a fixture containing one ambiguous time yields two slots and a note
- [ ] 5.2 Implement calendar conflict filtering with the Calendar freebusy API; verify a test with a mocked calendar that an overlapping slot is removed and an all-conflict case produces a digest flag and no confirmation email
- [ ] 5.3 Implement single-use slot tokens (hashed at rest, 7-day expiry) and the `GET /confirm/:token` page with a POST confirm; verify an API test that GET never confirms, POST confirms once, sibling tokens are invalidated, and a reused or foreign-tenant token is rejected
- [ ] 5.4 Send the confirmation request email through `sendEmail` with one link per slot; verify a test that the recruiter thread has no reply after the request is sent
- [ ] 5.5 Implement the `book-interview` job: reply on the thread with the slot template, create the Calendar event, store the event id, set status Interviewing, log both; verify an integration test with mocked Gmail and Calendar, including the event-creation-failure path that retries the event without re-sending the reply
- [ ] 5.6 Implement reschedule handling when new times arrive on a confirmed interview; verify a test that a second proposal creates new slots, sends a new confirmation request, and leaves the existing event untouched
- [ ] 5.7 Ensure booking links and compensation flags never produce slots or replies; verify tests for the booking-link thread (digest only) and the slots-plus-salary thread (slots offered, reply contains no pay text)

## 6. Notifications

- [ ] 6.1 Implement reminder scheduling at confirmation (T-24h and T-1h, singleton per interview and offset) and cancellation on reschedule; verify a test with a fake clock that the three reminder scenarios in the `notifications` spec produce the right sends
- [ ] 6.2 Implement the daily digest job assembled from `activity_log` and pending items, scheduled per user at `digest_hour` in `timezone` with a `(user_id, date)` singleton; verify a test that a day with no activity still sends a short digest and that changing the hour yields at most one digest that day
- [ ] 6.3 Add the digest-hour and time-zone settings endpoint in `apps/api`; verify an API test that an update is reflected in the next scheduled digest
- [ ] 6.4 Route the CAPTCHA request email from `captcha-escalation` through `sendEmail` as an immediate send; verify a test that it is sent within the job run and not deferred to the digest

## 7. Integration checks

- [ ] 7.1 Run an end-to-end scenario on a seeded tenant with mocked Google APIs: application submitted, recruiter proposes times, user confirms via POST, recruiter reply sent, event created, status Interviewing, reminders scheduled; verify the Playwright e2e test passes and no outgoing message contains `$`, salary, compensation or equity
- [ ] 7.2 Run `openspec validate inbox-and-scheduling --strict` and the full Vitest suite; verify both pass clean

## Workflow follow-up

- Archive the change after the e2e scenario is demonstrated on the simulated recruiter from `dashboard-and-demo`.
