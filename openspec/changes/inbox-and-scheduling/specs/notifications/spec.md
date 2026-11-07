# Spec Delta

## Purpose

Delivers everything the agent needs to tell the user by email, in one daily batch except for the few events that cannot wait, and guards every outgoing message so nothing about money ever leaves the system.

## ADDED Requirements

### Requirement: Daily digest
The system SHALL send each user one digest email per day at the hour the user chose, summarizing that day's applications, employer replies, pending confirmations, blocked sends, items needing the user's input, and upcoming interviews.

#### Scenario: Digest at the chosen hour
- **WHEN** the user's chosen digest hour arrives in their time zone
- **THEN** one digest email is sent containing the applications submitted, threads classified, follow-ups sent, pending slot confirmations, compensation and booking-link threads, pending CAPTCHA requests, blocked outgoing messages, and interviews in the next seven days since the previous digest

#### Scenario: Nothing happened
- **WHEN** the digest hour arrives and no activity occurred since the previous digest and nothing is pending
- **THEN** a short digest is still sent stating that there was no activity

#### Scenario: Digest hour changed
- **WHEN** the user changes their digest hour
- **THEN** the next digest is sent at the new hour and at most one digest is sent per calendar day

#### Scenario: Digest send fails
- **WHEN** the digest email cannot be sent
- **THEN** the failure is written to the activity log and the send is retried up to three times within the hour

### Requirement: Immediate notifications
The system SHALL send an email immediately, outside the digest, for an interview slot confirmation request and for a CAPTCHA request, and for nothing else.

#### Scenario: Slot confirmation request
- **WHEN** interview scheduling has non-conflicting slots to confirm
- **THEN** the confirmation email is sent within one minute of the slots being determined

#### Scenario: CAPTCHA request
- **WHEN** the CAPTCHA escalation reaches the human stage for an application
- **THEN** the request email provided by the escalation is sent within one minute, using the user's notification address

#### Scenario: Other events do not interrupt
- **WHEN** an application is submitted, a thread is classified or a follow-up is sent
- **THEN** no immediate email is sent and the event waits for the digest

### Requirement: Interview reminders
The system SHALL send a reminder email 24 hours and 1 hour before each confirmed interview, each containing the company, role, interviewer where known, and a link to the interview's card.

#### Scenario: Reminders for a confirmed interview
- **WHEN** an interview is confirmed for a time more than 24 hours away
- **THEN** one reminder is sent 24 hours before and one 1 hour before the start time

#### Scenario: Interview confirmed within 24 hours
- **WHEN** an interview is confirmed for a time less than 24 hours but more than 1 hour away
- **THEN** only the 1-hour reminder is sent

#### Scenario: Interview rescheduled
- **WHEN** a confirmed interview's slot changes to a new confirmed time
- **THEN** reminders for the old time are cancelled and reminders for the new time are scheduled

### Requirement: Outgoing-mail content guard
The system SHALL check every outgoing email on every send path before it leaves, and SHALL block any message whose subject or body contains a dollar sign or the words salary, compensation or equity, regardless of case.

#### Scenario: Clean message
- **WHEN** an outgoing email contains none of the blocked content
- **THEN** it is sent

#### Scenario: Message contains a dollar sign
- **WHEN** an outgoing reply to a recruiter contains "$" anywhere in its body
- **THEN** it is not sent, the block is written to the activity log with the matched content, and the block appears in the user's next digest

#### Scenario: Message contains a blocked word in any case
- **WHEN** an outgoing email contains "Compensation" in its subject
- **THEN** it is not sent and the block is logged

#### Scenario: Guard applies to user-facing mail too
- **WHEN** a digest, confirmation request or reminder to the user would contain blocked content
- **THEN** the guard rewrites the user-facing message to omit the offending employer text and references the thread by company and role instead, so the user is still notified

### Requirement: Outgoing messages are stored
The system SHALL store every sent email with its recipient, subject, body, send time and the application or interview it concerns, and SHALL write each send and each block to the activity log.

#### Scenario: Reply to recruiter is sent
- **WHEN** a scheduling reply is sent on a recruiter thread
- **THEN** the message is stored against the application with the thread id and the activity log records the send

#### Scenario: Send is blocked
- **WHEN** the content guard blocks a message
- **THEN** the message is stored with a blocked marker and is never retried automatically

### Requirement: Email is the only channel
The system SHALL deliver all notifications by email to the user's sign-in address and SHALL offer no other channel.

#### Scenario: User's sign-in address is the destination
- **WHEN** any notification is sent to a user
- **THEN** it is addressed to the email the user signed in with
