# Wave 3 review findings (Codex, 2026-11-07) and dispositions

One read-only Codex review. All 25 findings accepted. Added from agent self-reports: (a) the CAPTCHA request email must scrub company name and job title before the guard and treat a blocked result as email_failed; (b) it must be stored with kind captcha_request and its application id. Decisions: outgoing_messages stores a redacted body (token URLs replaced) and a per-send delivery key (kind + logical id) that sendEmail writes BEFORE calling Gmail as a pending receipt and finalizes after, so an uncertain send reconciles instead of repeating; offerSlots is split into recordOffer (inside the message transaction) and sendOfferEmail (after commit, repaired by resendPendingConfirmations); Calendar events get a client-generated id persisted before insert; the book-interview queue uses the exclusive policy at both creation sites; a confirmed slot generation id binds booking writes.

The patch has externally visible crash and concurrency failures: duplicate recruiter replies and Calendar events, unusable confirmation links, lost inbox messages, and backward status transitions. Token persistence, authentication handling, and notification scheduling also violate the stated invariants.

Full review comments:

- [P1] Redact confirmation tokens from persisted outgoing bodies — /home/hdx/code/weapons-of-mass-application/packages/db/src/repos/outgoing_messages.ts:98-100
  Confirmation emails contain live `/confirm/<token>` links, and these fields persist those links verbatim in `outgoing_messages`. Consequently, tokens are stored in plaintext despite the hash-only-at-rest requirement; reading the mail audit table yields capabilities that can confirm interviews through the public route. Redact token-bearing URLs in the persisted copy without changing the delivered email.

- [P1] Send confirmation requests after the message transaction commits — /home/hdx/code/weapons-of-mass-application/apps/worker/src/inbox/sync.ts:308-310
  `offerSlots` is invoked inside the message transaction, so its nested slot transaction does not provide the independent commit promised by the design. The confirmation email can leave Gmail before the slots commit. A crash then leaves the user with nonexistent links; a send failure rolls back the slots and records the message as permanently failed, leaving nothing for the pending-confirmation repair pass. Persist a durable scheduling obligation and send after commit.

- [P1] Make accepted Gmail sends recoverable before retrying — /home/hdx/code/weapons-of-mass-application/packages/shared/src/mail.ts:175-176
  If Gmail accepts the message and the process crashes or `store.record` fails, no durable receipt remains and the caller retries the actual send. This can duplicate recruiter acceptances and follow-ups; holding a database transaction during Gmail delivery cannot roll back the external send. Introduce a durable delivery identity and reconciliation mechanism so an uncertain accepted send is not blindly repeated.

- [P1] Make Calendar event creation idempotent across crashes — /home/hdx/code/weapons-of-mass-application/apps/worker/src/scheduling/book.ts:137-138
  If Calendar creates an event but its response is lost, or the worker crashes before saving `calendarEventId`, the next run calls `createEvent` again. The production insert supplies no deterministic event ID, so retries create duplicate interviews. Persist a stable event identity before insertion and reconcile an already-created event on retry.

- [P1] Create the booking queue with exclusive singleton semantics — /home/hdx/code/weapons-of-mass-application/apps/worker/src/jobs/book-interview.ts:64-64
  `BOOK_QUEUE_OPTIONS` contains only retry settings, leaving this queue with the standard policy; the API also creates it without an exclusive policy. A `singletonKey` alone does not exclude duplicate standard-policy jobs. The hourly repair pass can therefore enqueue another booking while one is pending or running, and concurrent consumers can both observe `replySentAt = null` and send duplicate recruiter replies or create duplicate events. Configure the same exclusive policy at both creation sites.

- [P1] Serialize booking against replacement of the confirmed slot — /home/hdx/code/weapons-of-mass-application/apps/worker/src/scheduling/book.ts:80-83
  An hourly sync can offer replacement times while this job awaits `replyContext`, clearing the interview's confirmation and reply markers. The job nevertheless sends using its earlier snapshot and subsequently writes `replySentAt` onto the replacement request. This sends an obsolete acceptance while the current request is unconfirmed and can suppress the reply for the newly confirmed slot. Serialize these operations and bind booking writes to a specific confirmed-slot generation.

- [P1] Apply status transitions atomically against the current status — /home/hdx/code/weapons-of-mass-application/apps/worker/src/scheduling/book.ts:152-155
  `nextStatus` operates on an unlocked snapshot, followed by an unconditional update. For example, booking can read `applied`, mail sync can commit a rejection to `closed`, and booking can then overwrite it with `interviewing`. The same race can overwrite an offer. Lock the application while calculating and applying transitions, or use a conditional update that retries against the latest status.

- [P1] Propagate mailbox authentication failures out of message processing — /home/hdx/code/weapons-of-mass-application/apps/worker/src/inbox/sync.ts:324-326
  A 401 or `invalid_grant` raised while `offerSlots` sends the confirmation email reaches this generic failure path. The message is permanently marked failed, the batch advances its history ID, and `runMailSync` never executes its revocation handler. Rethrow authentication failures before recording a per-message failure so the mailbox is marked revoked and the high-water mark remains unchanged.

- [P1] Preserve the dated fallback boundary when messages are deferred — /home/hdx/code/weapons-of-mass-application/apps/worker/src/inbox/sync.ts:136-139
  On a first sync or an expired-history fallback, a calendar failure leaves the message unprocessed but still advances `lastSyncedAt`. The next dated listing starts only one day before that new timestamp, so a deferred invitation older than one day disappears from the retry window permanently. Preserve the fallback checkpoint until all deferred messages are handled, or persist their IDs independently.

- [P1] Refuse to advance history after a truncated Gmail listing — /home/hdx/code/weapons-of-mass-application/apps/worker/src/inbox/gmail-reader.ts:110-113
  Both listing methods stop after `MAX_PAGES` even when `nextPageToken` remains. `listHistory` then returns the mailbox history ID as though every page was consumed; the dated fallback likewise advances past messages beyond its 2,000-message cap. Those messages are permanently skipped. Exhaust pagination or fail the batch without advancing its checkpoint when the limit is reached.

- [P1] Exclude compensation-flagged threads from automatic follow-ups — /home/hdx/code/weapons-of-mass-application/apps/worker/src/inbox/follow-up.ts:93-94
  An otherwise-confirmation message can independently have `compensationFlag = true`. This check admits that thread, obtains its sender, and sends an automatic follow-up despite the rule that compensation-flagged threads receive nothing automatically. Check the compensation flag before selecting a contact; the content guard cannot enforce this prohibition because the follow-up itself contains no guarded terms.

- [P2] Match recovered recruiter replies to their interview and slot — /home/hdx/code/weapons-of-mass-application/apps/worker/src/scheduling/book.ts:70-73
  The recovery lookup accepts any recruiter reply for the application sent after confirmation. If two interview threads for the same application are confirmed before either is booked, sending the first reply makes the second booking incorrectly treat that reply as its own and skip contacting its recruiter. Persist and match an interview/confirmed-slot delivery identity instead of using application ID and timestamp alone.

- [P2] Prevent older messages from overwriting newer thread metadata — /home/hdx/code/weapons-of-mass-application/apps/worker/src/inbox/sync.ts:219-222
  Gmail's dated message listing returns newest messages first. Processing an older confirmation afterward preserves the newer `lastMessageAt` but overwrites its kind, compensation flag, and booking link with the older classification. This can erase a pay warning or scheduling link and make a replied-to thread eligible for follow-up. Make metadata updates chronological and preserve thread-level compensation flags.

- [P2] Reject confirmation of slots that have already started — /home/hdx/code/weapons-of-mass-application/packages/db/src/repos/interview_slots.ts:149-152
  A token remains valid for seven days even when its interview time passes earlier. These conditions check token expiry but not `startsAt`, so a user can confirm yesterday's interview and trigger a recruiter acceptance and Calendar event in the past. Include a database-clock future-start check in the atomic confirmation and read-only open-state calculation, and reject stale delayed bookings as well.

- [P2] Track whether the current reschedule reached Calendar — /home/hdx/code/weapons-of-mass-application/packages/db/src/repos/scheduling-pending.ts:40-41
  A reschedule retains the old `calendarEventId`. Once its new reply is recorded, this predicate excludes the interview even if updating the old event fails or never happens. After booking retries are exhausted, the hourly repair pass therefore cannot repair the reschedule and Calendar remains at the old time. Track completion for the confirmed-slot generation rather than treating any existing event ID as completion.

- [P2] Enqueue reminders independently when confirmation commits — /home/hdx/code/weapons-of-mass-application/apps/worker/src/scheduling/book.ts:112-112
  Reminders are only scheduled after the recruiter reply succeeds. If that send is blocked or unavailable until a reminder deadline passes, the interview remains confirmed but its reminders are never scheduled; later booking skips elapsed offsets. Persist reminder scheduling at confirmation, as required, rather than making it depend on successful recruiter delivery.

- [P2] Recover reminder replacement when the old singleton is active — /home/hdx/code/weapons-of-mass-application/apps/worker/src/notifications/reminders.ts:73-78
  During rescheduling, `cancelByKey` cancels queued jobs only. If an old reminder is already active, the exclusive queue rejects the replacement with the same singleton key and returns null. This result is ignored, so the new reminder is silently lost after the old job finishes. Persist/retry unsuccessful replacement enqueues; the fake queue's lack of an active state leaves this case untested.

- [P2] Read the booking-link field actually emitted by mail sync — /home/hdx/code/weapons-of-mass-application/apps/worker/src/notifications/digest.ts:177-180
  Mail sync emits booking-link activity details as `{ kind: 'booking_link', link: ... }`, but the digest reads `booking_link`. Real digests consequently omit the scheduling URL, even though the booking-link path offers no slots or automatic reply. Align the producer and consumer; the current digest test seeds the consumer's invented field instead of exercising the real activity shape.

- [P2] Include unresolved flagged threads in every digest — /home/hdx/code/weapons-of-mass-application/apps/worker/src/notifications/digest.ts:112-116
  Compensation and booking-link threads are sourced only from activity entries since the previous digest; no query loads their persistent thread flags. After the first digest, an unresolved pay discussion or unused booking link disappears from subsequent digests. Query pending flagged `email_threads` in addition to recent activity and deduplicate the resulting items.

- [P2] Checkpoint digest activity at the collected cutoff — /home/hdx/code/weapons-of-mass-application/apps/worker/src/notifications/digest.ts:254-257
  The next digest starts at the previous outgoing message's `sentAt`, which is recorded after collection and Gmail delivery. Activity committed after `collectDigestSections` reads it but before that send timestamp appears in neither digest: it was absent from the first and is older than the next cutoff. Store a collection cutoff/cursor and use that checkpoint for subsequent activity reads.

- [P2] Recover notification completion from persisted delivery receipts — /home/hdx/code/weapons-of-mass-application/apps/worker/src/notifications/digest.ts:286-290
  Even when Gmail delivery and the outgoing row both succeed, a crash before this activity entry makes the retry send another digest because its only duplicate check is `digest_sent`. Reminders have the same gap before `reminder_sent`. Persist a logical date/offset delivery key with the outgoing receipt and recover completion from it rather than relying solely on a later activity write.

- [P2] Send the daily digest when its local hour is skipped by DST — /home/hdx/code/weapons-of-mass-application/apps/worker/src/notifications/digest.ts:64-64
  For a user configured for hour 2 in `America/Los_Angeles`, the spring-forward day has no matching local hour, so this equality skips the digest for the entire day, including the required quiet-day digest. Schedule the first valid time after the missing hour, retaining the local-date singleton to avoid duplicates on repeated hours.

- [P2] Display both offsets for slots crossing a DST transition — /home/hdx/code/weapons-of-mass-application/apps/worker/src/scheduling/slots.ts:75-75
  A fall-back slot from `2026-11-01T01:30:00-07:00` to `2026-11-01T01:30:00-08:00` renders as `1:30 AM to 1:30 AM PST`, although its start is PDT. Omitting the start's zone makes the offered instant ambiguous precisely when the user must confirm it. Show both zones/offsets when they differ and apply the same correction to the confirm-page formatter.

- [P2] Preserve authentication errors from Calendar operations — /home/hdx/code/weapons-of-mass-application/apps/worker/src/scheduling/book.ts:147-148
  When Calendar access raises `invalid_grant`, this catch replaces it with `EventCreationError`. `runBookInterview` therefore cannot recognize the revoked grant, and retries run instead of marking the connection revoked. The freebusy wrapper similarly converts authentication failures into indefinitely deferred calendar work. Preserve authentication errors through these wrappers before translating retryable Calendar failures.

- [P2] Derive reminder wording from the actual local date and time — /home/hdx/code/weapons-of-mass-application/apps/worker/src/notifications/templates.ts:34-35
  A fixed 86,400-second offset does not always mean 'tomorrow' locally: for an interview at 23:30 PST on the fall-back day, T-24h is 00:30 PDT on that same day. Delayed jobs can also send 'tomorrow' or 'in about an hour' long after those descriptions are true. Pass the current time into rendering and derive relative wording in the user's timezone, while retaining the absolute interview time.
