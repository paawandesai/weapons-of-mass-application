# Spec Delta

## Purpose

Turns an employer's proposed interview times into a confirmed slot on the user's calendar, with the user's explicit confirmation as the only path to a booking.

## ADDED Requirements

### Requirement: Proposed time extraction
The system SHALL extract every concrete date and time range offered in an interview-classified thread, normalized to the user's time zone, and SHALL record them as proposed slots on an `interviews` row linked to the application.

#### Scenario: Recruiter proposes three times
- **WHEN** an interview-classified message offers three specific date and time options
- **THEN** an `interviews` row is created for the application with those three slots in the user's time zone

#### Scenario: Message asks for availability without proposing times
- **WHEN** an interview-classified message asks the user for availability and offers no concrete times
- **THEN** no slots are recorded, the thread is flagged as needing the user's input, and it appears in the next digest

#### Scenario: Times are ambiguous
- **WHEN** a proposed time lacks a date, a year or a time zone that cannot be inferred from the thread
- **THEN** that option is excluded from the proposed slots and the exclusion is noted on the interview row

### Requirement: Conflict filtering against the calendar
The system SHALL remove any proposed slot that overlaps an existing event on the user's connected calendar before presenting options to the user.

#### Scenario: One slot overlaps an existing event
- **WHEN** three slots are proposed and one overlaps an event on the user's calendar
- **THEN** the user is offered the two non-conflicting slots only

#### Scenario: Every slot conflicts
- **WHEN** all proposed slots overlap existing calendar events
- **THEN** no confirmation request is sent, the thread is flagged as needing the user's input, and the digest shows the conflicts

#### Scenario: Calendar cannot be read
- **WHEN** the calendar read fails during conflict filtering
- **THEN** no confirmation request is sent, the failure is written to the activity log, and the filtering is retried on the next sync

### Requirement: User confirmation request
The system SHALL send the user an immediate email listing the non-conflicting slots, each with a single-use confirmation link, and SHALL send nothing to the employer at that point.

#### Scenario: Confirmation request is sent
- **WHEN** at least one non-conflicting slot exists for an interview
- **THEN** the user receives one email naming the company, role and each slot with its own confirmation link, and no reply has been sent on the recruiter thread

#### Scenario: Confirmation link is used
- **WHEN** the user opens a confirmation link for a slot that is still unconfirmed
- **THEN** that slot is recorded as confirmed with a timestamp and the other links for the same interview stop working

#### Scenario: Confirmation link is reused or expired
- **WHEN** a confirmation link is opened after a slot for that interview was already confirmed, or after it expired
- **THEN** no change is made and the user is shown the current state of the interview

#### Scenario: Confirmation link for another tenant
- **WHEN** a confirmation link is presented with a token that does not belong to the signed-in user's tenant
- **THEN** the request is rejected and nothing is confirmed

### Requirement: Booking only after confirmation
The system SHALL reply to the employer and create the calendar event only after the user has confirmed a slot, and SHALL never create an event or accept a time on the user's behalf without that confirmation.

#### Scenario: User confirms a slot
- **WHEN** the user confirms a slot
- **THEN** the system replies on the recruiter thread accepting that slot, creates a calendar event for it naming the company, role and interviewer where known, stores the event id on the interview row, sets the application status to Interviewing, and logs both actions

#### Scenario: User has not confirmed
- **WHEN** a day passes with proposed slots and no confirmation from the user
- **THEN** no reply is sent to the employer, no event is created, and the pending confirmation is repeated in the daily digest

#### Scenario: Event creation fails after the reply
- **WHEN** the reply to the recruiter succeeds but the calendar event cannot be created
- **THEN** the failure is written to the activity log, the interview row records the confirmed slot without an event id, the event creation is retried, and the user is told in the next digest if it still fails

### Requirement: Booking links are never followed
The system SHALL forward a self-service scheduling link to the user and SHALL not open it, select a time on it, or submit any form on it.

#### Scenario: Interview thread contains a booking link
- **WHEN** an interview-classified thread contains a scheduling-page link
- **THEN** the link is sent to the user in the next digest, no slots are proposed, and no reply is sent to the employer

### Requirement: Compensation is never discussed in scheduling replies
The system SHALL leave any question about compensation in an interview thread unanswered and SHALL surface it to the user.

#### Scenario: Recruiter asks for salary expectations alongside times
- **WHEN** an interview-classified message proposes times and also asks for salary expectations
- **THEN** the slots are extracted and offered to the user, the thread is flagged as compensation, and the eventual acceptance reply addresses only the time and contains nothing about pay

### Requirement: Rescheduling
The system SHALL treat a new set of proposed times on a thread with a confirmed interview as a reschedule request that requires the user's confirmation again.

#### Scenario: Recruiter proposes new times after confirmation
- **WHEN** a confirmed interview's thread receives a message proposing different times
- **THEN** new slots are recorded, the existing calendar event is left in place, the user receives a new confirmation request, and no reply is sent until they confirm
