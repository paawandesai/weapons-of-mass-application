# Inbox sync and follow-ups

How the worker reads the user's Gmail, links replies to applications, moves cards, and sends the one follow-up. Behavior is specified in `docs/design/wave3-inbox.md` (rules 1 to 7, 12, 17); this page describes the code.

## Files

| Path | Role |
| --- | --- |
| `apps/worker/src/jobs/mail-sync.ts` | Hourly tick (`mail-sync-tick`, cron `7 * * * *`) enqueues `mail-sync` per approved user (`db.digestRoster()`), singleton key `mail-sync:<userId>`; the handler runs `runMailSync` through `guardedJob`. |
| `apps/worker/src/jobs/follow-up.ts` | Consumer of the `follow-up` queue that submission fills (job id and singleton key are the application id). |
| `apps/worker/src/inbox/sync.ts` | `runMailSync`, `processMessage`. |
| `apps/worker/src/inbox/gmail-reader.ts` | `InboxGmailPort` (history list, dated list, message, thread) over the user's Google connection; `parseGmailMessage`, `isAuthError`. |
| `apps/worker/src/inbox/link.ts` | Deterministic linking, then `inbox-link@v1`. |
| `apps/worker/src/inbox/classify.ts` | `inbox-classify@v1` with the shared `InboxClassification` schema. |
| `apps/worker/src/inbox/flags.ts` | `flagDigest`: writes `digest_flag` activity entries (`activity_on_closed`, `booking_link`, `compensation`, `no_free_slot`) that the digest reads. |
| `apps/worker/src/inbox/follow-up.ts`, `templates/follow-up.ts` | `runFollowUp` and the plain template. |
| `apps/worker/src/inbox/deps.ts`, `wiring.ts` | `InboxDeps` (Gmail, LLM, `mail`, `recordOffer`, `sendOfferEmail`, `flagDigest`, clock) and the production wiring. |
| `packages/llm/prompts/inbox-link/v1.md`, `inbox-classify/v1.md` | Prompts. |

## Sync

1. Read the high-water mark (`mail_sync_state.history_id`). With a mark, call `history.list` (messages added to the inbox). Without one, or when Gmail says the id is too old (404), read the current history id first, then list inbox messages with `after:` one day before the last sync (or before the oldest application). Ids deferred by an earlier run (`mail_sync_state.deferred_message_ids`) are added to every batch. A listing that still has pages after 100 pages throws `ListingTruncatedError`: the sync fails and the mark does not move.
2. Skip ids already in `processed_messages`. For each remaining message: fetch it, then process it.
3. Per message: ignore the user's own sent mail and mail from the user's own address; link; classify; then one transaction writes the processed marker, the thread row, the status change and its activity entry, and the digest flags. Linking and classification run before the transaction so no connection is held across model calls. A failure at any step records the message as `failed` with a `processing_failed` entry and moves on.
4. After the batch, store the new history id and `last_synced_at` and clear `reauth_needed`. A Gmail error other than a rejected credential propagates and the queue retries with the mark unchanged; messages already committed are skipped on the retry.
5. A message with proposed slots and no booking link on a non-closed application is handed to `deps.recordOffer` as the last step of its transaction (slots and token hashes only; nothing is sent). If the calendar cannot be read (`CalendarUnavailableError`) the message rolls back, is not marked processed, and its id is stored in `deferred_message_ids`; the mark moves on and the next hourly sync retries exactly those ids, so a dated fallback window cannot lose them. After the transaction commits, `deps.sendOfferEmail` sends the confirmation request; a failure other than authentication logs `offer_email_failed` and is repaired by `resendPendingConfirmations`. A rejected credential anywhere in message processing (including the send) is rethrown, never recorded as a per-message failure, so the revocation handler runs and the mark holds. Any other scheduling error fails that message only. The sync itself never sends mail to the recruiter.
6. After the mark moves, `resendPendingConfirmations` and `requeueUnbookedInterviews` run for the user (the scheduling repair passes).

A rejected credential (401, `invalid_grant`, or no stored grant) calls `markRevoked`, logs `mailbox_reauth_needed`, sets `reauth_needed`, leaves the mark alone and returns without throwing. Further rejections while the flag is set do not log again.

## Linking

Within the user's non-closed applications: sender domain (company domain, or an ATS domain together with the company name in sender, subject or body) narrows to the company's applications; the job title as a whole phrase picks among them. Exactly one title match links without the model. Zero or several matches go to `inbox-link@v1` with the shortlist (a company with no title mention sends the company's applications; with no company evidence the title matches alone are sent). The model's id must be one of the candidates. A message with no evidence at all is never sent to any model. Only when nothing among the open applications shows any evidence are closed applications checked, deterministically, so mail for a rejected application is flagged instead of dropped. A thread that already has a row keeps its application.

## Follow-up

The `follow-up` job sends only when the application is still `applied`, `applied_at` is at least seven days old, `followed_up_at` is empty, no linked thread other than a `confirmation` exists, and a replyable address is known. The address is the first sender in a linked confirmation thread that is not the user and not a no-reply or bounce mailbox. Every skip writes `follow_up_skipped` with a reason (`already_followed_up`, `not_applied`, `too_early`, `employer_replied`, `no_contact`, `blocked`, `reauth_needed`). The send goes through `sendEmail`; the stored message, `followed_up_at` and the `follow_up_sent` entry commit together under a row lock.

## Tests

`apps/worker/test/inbox/` with fictional recorded messages in `apps/worker/test/fixtures/inbox/`. Gmail is a fake port (the real port is exercised against a stub client), the model is `FakeLlm`, and the database is the test database.

## Delivery receipts

Every keyed send (`deliveryKey`: follow-up `follow_up:<application id>`, captcha `captcha_request:<request id>:<attempt>`) writes a pending `outgoing_messages` row before Gmail is called and finalizes it after. A repeat with the same key returns the stored result (`alreadySent`) or, while the row is still pending, `uncertain` without sending. `reconcileOutgoing` (and `sendEmailRecovering`, which uses it once) resolves a pending row by searching the mailbox's Sent mail (`createSentLookup`): found means the row is finalized with that message id, not found means the row is removed and the send is repeated once. A 4xx refusal from Gmail removes the receipt immediately. Persisted bodies replace `/confirm/<token>` with `/confirm/[redacted]`; the delivered email is unchanged. A thread flagged for compensation never receives an automatic follow-up, and thread metadata is updated chronologically (an older message never overwrites a newer kind, link or prompt version; the compensation flag stays set).
