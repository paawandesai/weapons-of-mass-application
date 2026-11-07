# Design

## Context

See proposal.md for motivation. Constraints that shape the approach: the user's Gmail and Calendar are reached with the tokens granted at Google sign-in (`google-sign-in`); mail sync runs as a worker job on the one droplet; the simulated recruiter used in the demo writes into the same mailbox the real recruiters would, so the inbox loop must not distinguish them; the "nothing about money" rule in PRD section 10 is an acceptance criterion, not a prompt instruction.

## Goals / Non-Goals

**Goals:**
- One mail-processing path that is idempotent per message and per thread.
- One confirmation mechanism that is the sole way an interview gets booked.
- One send function that every outgoing email goes through, with the content guard inside it.
- Every state change traceable in the activity log.

**Non-Goals:**
- Real-time mail processing; one hour of latency is acceptable.
- Reading mail beyond threads that match an application.
- Handling calendar invites sent as .ics attachments by the employer; those are surfaced to the user like booking links.

## Decisions

**Polling with the history API, not Gmail push.** The hourly job calls Gmail `history.list` from the stored `historyId` and falls back to `messages.list` with an `after:` filter when the history id is too old. Pub/Sub push would need a public endpoint, a topic and watch renewals, which is more surface than an hourly cadence justifies. The per-user `historyId` is the high-water mark; it is advanced only after every message in the batch has been processed and committed.

**Idempotency keys.** `email_threads` is unique on `(tenant_id, gmail_thread_id)`; processed messages are recorded in a `processed_messages` table unique on `(tenant_id, gmail_message_id)` so a crash between fetch and commit cannot double-process. Inserts use upsert semantics.

**Linking before classifying.** Linking is deterministic first: sender domain matched against the company's known domains (from the ATS board and the application confirmation), then title match against that company's applications. Only if that yields zero or several candidates does the LLM get the message plus the candidate list to disambiguate, with structured output `{application_id | null}`. Unlinked messages are never sent to the LLM for classification; this keeps the model away from the user's unrelated mail.

**Classification and extraction in one structured call.** For a linked thread, one LLM call with structured output returns `{classification, compensation_flag, booking_link, proposed_slots[]}`. Slot extraction produces ISO timestamps with explicit offsets; anything the model marks `ambiguous` is dropped and noted. Prompt is versioned in `packages/llm/prompts/inbox-classify.vN.md` and the version is stored on the thread row so later changes are comparable.

**Status transitions are a pure function.** `nextStatus(current, classification)` lives in `packages/shared` with the forward-only rule and the Closed sink encoded there, and is unit-tested exhaustively. Workers call it; nothing else mutates status from mail.

**Confirm-slot link is a signed, single-use token.** Each proposed slot gets a token: random 32 bytes stored hashed on the `interview_slots` row with the tenant id, user id, interview id and an expiry of 7 days. The link is `GET /confirm/:token`, which renders a confirmation page and a POST button (so mail scanners that prefetch links cannot confirm). The POST is a transaction: verify token hash, expiry and that the interview has no confirmed slot, then set `confirmed_at`, invalidate sibling tokens, and enqueue the `book-interview` job. Tenant check compares the token's tenant with the signed-in session where one exists and otherwise relies on the token alone, which is acceptable because the token is unguessable and single-use.

**Booking is a job, not inline.** `book-interview` replies on the thread, creates the Calendar event, stores the event id, then sets status Interviewing. If event creation fails after the reply succeeded, the job retries event creation only (the reply is recorded as sent) and the digest reports the gap; we accept a reply without an event over a duplicate reply.

**Outgoing-mail guard is inside `sendEmail`.** There is exactly one `sendEmail(tenantId, {to, subject, body, concerns})` in `apps/worker`. It runs the guard (regex `\$|\bsalary\b|\bcompensation\b|\bequity\b`, case-insensitive, on subject and body) before calling the Gmail send API. A block writes a stored message with `blocked: true` and an activity-log row and returns a typed result; callers cannot bypass it because the Gmail client is not exported. For user-facing mail (digest, confirmation, reminders) the templates render employer text through a scrubber that replaces the matched content with "[omitted]" before the guard runs, so the guard blocking a user notification is a bug, not a feature.

**Follow-ups and reminders use pg-boss scheduled jobs.** On submission, `application-submission` enqueues `follow-up` with `startAfter = applied_at + 7d` and `singletonKey = application_id`. The job re-checks status, linked threads and `followed_up_at` at run time. Reminders are enqueued at confirmation with `startAfter` for T-24h and T-1h and a singleton key per interview and offset; rescheduling cancels by key and re-enqueues.

**Digest is assembled from the activity log, not from ad-hoc state.** The digest job queries `activity_log` since the last digest's `sent_at` plus pending items (unconfirmed slots, compensation and booking-link threads, pending CAPTCHAs, blocked sends, interviews within 7 days). The user's `digest_hour` and `timezone` live on `users`; a scheduler enqueues the digest job per user per day with a singleton key of `(user_id, date)`.

**Alternatives considered.** Gmail push via Pub/Sub (rejected: more infrastructure for no demo benefit). Letting the LLM reply free-form to the recruiter (rejected: the acceptance reply is a template with the slot filled in, so there is nothing to guard beyond the employer-quoted text). Confirming via a GET link (rejected: link prefetchers would book interviews).

## Risks / Trade-offs

- [Mis-linking a thread to the wrong application] → deterministic match first, LLM only to disambiguate among candidates, and the digest shows every link so the user can catch it on the card.
- [LLM misclassifies a rejection as other] → the card stays Applied, which is the safe side; the digest lists every classified thread.
- [Slot extraction gets the time zone wrong] → slots are shown to the user with the explicit zone before confirmation; the user is the check.
- [Guard regex is too blunt and blocks a legitimate reply] → acceptable for the MVP; blocked sends are visible in the digest and the user can send the message themselves.
- [Gmail history id expires after long inactivity] → fall back to a date-filtered message list and reconcile with `processed_messages`.
- [Google OAuth testing mode and token refresh] → refresh failures mark the connection as needing re-authorization and the digest tells the user; nothing silently stops.

## Migration Plan

Greenfield: migrations add `email_threads`, `processed_messages`, `interviews`, `interview_slots`, `outgoing_messages`, and columns `applications.followed_up_at`, `users.digest_hour`, `users.timezone`. No rollback concerns beyond dropping the tables.

## Open Questions

- Which employer address receives the follow-up when the ATS confirmation came from a no-reply address: the spec records "no contact" and skips, and the demo's simulated recruiter supplies a real address. A later change can add contact discovery.
