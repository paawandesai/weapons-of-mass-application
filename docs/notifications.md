# Notifications

How the user hears from the agent: interview reminders, the daily digest, and the two immediate emails. Rules are numbered as in [docs/design/wave3-inbox.md](design/wave3-inbox.md) (13 reminders, 14 digest, 15 guard and scrubbing, 16 storage). Email to the user's sign-in address is the only channel.

Code: `apps/worker/src/notifications/` (logic), `apps/worker/src/jobs/{reminders,digest}.ts` (registration), `apps/api/src/routes/settings.ts` (settings).

## Immediate emails

Only two things interrupt the digest: the slot confirmation request and the CAPTCHA request. Both go through `sendEmail` inside the job that produces them. Nothing else (submissions, classifications, follow-ups) sends on its own; those wait for the digest.

## Reminders (rule 13)

`scheduleReminders(handle, interviewId, { queue, now })` is called when a slot is confirmed (the API enqueues a `schedule-reminders` job from the POST route, independent of the recruiter reply; the booking job calls it again as a backup) and again when a confirmed interview moves.

- It first cancels queued reminders for the interview, then enqueues one job per offset: 24 hours and 1 hour before the start. Singleton key `<interview_id>:<offset_seconds>`; queue policy `exclusive`.
- `cancel` reaches queued jobs only. If the old reminder for an offset is already running, the exclusive queue refuses the replacement; the scheduler then enqueues a delayed `schedule-reminders` retry (30 s, doubling, at most 6 attempts) so the new reminder is not lost. The old job, when it runs, sees the changed start and skips.
- An offset whose moment has passed is skipped: confirmed 5 hours out gets only the 1-hour reminder, less than an hour out gets none.
- An interview that is not confirmed schedules nothing.
- The job re-reads the interview when it runs and does nothing if it is no longer confirmed, if its start differs from the start the job was scheduled for, or if that reminder already went out. "Already went out" is read from the activity marker, and from the outgoing receipt under the delivery key `reminder:<interview_id>:<offset>:<start ISO>` (a crash after Gmail accepted the message but before `reminder_sent` is recognized and the entry is written, not the email repeated). The start is part of the key so a moved interview's reminder is a new delivery.
- The email names the company and role, the interviewer when scheduling recorded one, the absolute time in the user's zone, a link to the interview card and, only when `prep_plan_status = ready`, a link to the prep plan. The relative wording is derived at send time from the user's calendar: "in about 20 minutes", "in about an hour", "in about 4 hours", "today", "tomorrow" or "on Tuesday, Mar 12". A T-24h reminder for a 23:30 interview on the fall-back day says "today", and a delayed job never claims "tomorrow" when it is not.
- Logged as `reminder_sent` with `interview_id`, `offset_seconds`, `marker`, `outgoing_id`.

## Daily digest (rule 14)

An hourly tick (`digest-tick`, cron `0 * * * *`) reads `db.digestRoster()` (users with an approved profile) and enqueues one `digest` job for each user whose current local hour in their own time zone equals their `digest_hour`. When a DST gap removes that hour from the day (hour 2 on a spring-forward day in `America/Los_Angeles`), the digest goes out at the first valid hour after it (03:xx) instead of being skipped; a repeated hour (fall back) matches twice. The job carries the user's local date; the singleton key is `<user_id>:<local_date>` with the date computed in the user's zone.

At most one digest goes out per user per local date, however many times it is enqueued: the job writes `digest_sent` with `local_date`, and a run that finds one for its date does nothing. The send carries the delivery key `digest:<user_id>:<local_date>`; if Gmail accepted the message but the run died before `digest_sent`, the next run finds the sent receipt, writes `digest_sent` and the checkpoint, and sends nothing. A pending receipt of unknown outcome (reconciled against the mailbox when a lookup is configured) is never re-sent blindly: the run fails with `DeliveryUncertainError` and the queue retries.

Content: activity in (checkpoint, cutoff], where the cutoff is the clock reading taken before collection and the checkpoint (`digest_state.collected_through`, per user, only moves forward) is the previous digest's cutoff. Activity that commits while the digest is being sent therefore lands in the next digest, once. Before the first checkpoint exists the latest sent digest, or 24 hours back, is used.

| Section | Source |
|---|---|
| Applications submitted | activity `submitted` |
| Replies from employers | activity `thread_linked`, `status_changed` |
| Follow-ups sent, Interviews booked | activity `follow_up_sent`, `interview_booked` |
| Threads that need you | activity `digest_flag` (`detail.kind`: `compensation`, `booking_link` with `detail.link`, `activity_on_closed`, `no_free_slot`), `mailbox_reauth_needed`, and every `email_threads` row of an open application with `compensation_flag` or a `booking_link` (listed in every digest until the application closes; deduplicated against the activity entry by thread id) |
| Waiting for your confirmation | interviews with no confirmed slot and at least one open slot |
| Security checks waiting for you | `captcha_requests` at stage `human`, unresolved, not expired |
| Blocked messages | `outgoing_messages` with `blocked = true` in the window |
| Interviews in the next 7 days | confirmed interviews starting within seven days |

A day with nothing in any section still sends a short digest saying so.

A failed send writes `digest_failed` to the activity log and the job is retried by the queue three times, ten minutes apart (inside the hour). Only a successful send writes `digest_sent` and moves the checkpoint.

## Employer text and the guard (rule 15)

Every employer-supplied value that appears in a user-facing email (company, role, interviewer, thread notes, links) goes through `scrubEmployerText` before the template is built, replacing dollar amounts and the words salary, compensation and equity with `[omitted]`. The template wording itself avoids those words (it says "pay terms"). The guard still runs on every message as the backstop; a digest or reminder that the guard blocks is recorded as `digest_failed` with `blocked_by_guard` and is a bug.

## Settings

`GET /api/settings/notifications` returns `{digest_hour, timezone}`. `PUT` takes either or both: `digest_hour` an integer 0 to 23, `timezone` an IANA name the platform recognises (offsets such as `+01:00` are rejected; the stored value is the platform's canonical name). Anything else is a 400. The next tick reads the stored values.
