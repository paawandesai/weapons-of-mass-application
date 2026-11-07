# Proposal

## Why

After an application goes out, everything that matters arrives by email: confirmations, rejections, interview invitations and offers. Without an inbox loop the agent cannot move a card past Applied, cannot schedule an interview, and the user is back to reading recruiter mail by hand. This change closes the loop from "applied" to "interview on the calendar", which is the second half of the demo.

Implements PRD v1.2 sections 7.7 (email and scheduling), 7.8 (notifications), 8 (`email_threads` and `interviews` tables), 10 (no booking without confirmation, no compensation in email), 13 (confirmation acceptance criteria and the outgoing-mail content rule), and assumptions A7 (booking links forwarded) and A8 (compensation threads surfaced, never answered).

## What Changes

- Hourly sync of the user's Gmail that links each relevant thread to an application by company and job title, classifies it (confirmation, rejection, interview, offer, other), and stores it as an `email_threads` row.
- Classified mail drives application status: rejection moves the card to Closed with a reason, an interview invitation moves it to Interviewing, an offer moves it to Offer. Confirmation and other mail leave status unchanged.
- One follow-up email to the recruiter 7 days after applying, sent at most once per application and only while the application is still Applied with no reply.
- Interview scheduling: when a thread proposes times, the agent reads the user's calendar, selects slots that do not conflict, and emails the user a one-click confirmation. Only after the user confirms one slot does the agent reply to the recruiter and create the calendar event. An `interviews` row records proposed slots, the confirmed slot and the event id.
- Booking links (Calendly-style) are forwarded to the user in the digest; the agent never books them.
- Threads that raise compensation are surfaced in the digest and never answered by the agent.
- An outgoing-email guard that blocks any message, from any sender path, that contains a dollar sign or the words salary, compensation or equity. A blocked send is logged and surfaced in the digest.
- Notifications by email only: a daily digest at the user's chosen hour, immediate emails for slot confirmation and CAPTCHA requests, and reminders 24 hours and 1 hour before each confirmed interview.
- Every outgoing message is stored against its application and written to the activity log.

Out of scope for this change: interview prep plan content, negotiation data, the board and card UI, interviewer feedback (all in `dashboard-and-demo`); the CAPTCHA email body and reply form (owned by `captcha-escalation` in `application-submission`; this change only delivers it); SMS; automated booking of Calendly-style links; any email that discusses compensation or offer terms.

## Capabilities

### New Capabilities
- `inbox-sync`: reading the user's mailbox, linking threads to applications, classifying them and moving application status accordingly.
- `recruiter-follow-up`: the single timed follow-up to a recruiter after an application with no reply.
- `interview-scheduling`: turning proposed interview times into a user-confirmed slot, a recruiter reply and a calendar event, with the confirmation gate and the compensation and booking-link rules.
- `notifications`: the email channel to the user: daily digest, immediate confirmation and CAPTCHA requests, interview reminders, and the outgoing-mail content guard shared by every send.

### Modified Capabilities
None. `application-submission` already defines the `applied` status this change transitions from; `tenancy`, `google-sign-in`, `profile` and `activity-log` from `mvp-foundation` are used as-is.

## Impact

- New tables `email_threads` and `interviews`; new columns on `applications` for follow-up tracking (`followed_up_at`) and closed reason already defined in the PRD.
- New worker jobs: hourly mail sync per user, follow-up scheduler, reminder scheduler, daily digest per user.
- New API routes: slot confirmation by signed token, digest hour setting.
- Gmail read and send and Calendar read and write scopes granted at sign-in (`google-sign-in`) are exercised for the first time; token refresh failures become a visible state.
- The outgoing-mail guard is a dependency for `captcha-escalation`, which sends the CAPTCHA email through `notifications`.
- Demo dependency: the simulated recruiter in `dashboard-and-demo` must produce mail this change can classify and schedule from.
