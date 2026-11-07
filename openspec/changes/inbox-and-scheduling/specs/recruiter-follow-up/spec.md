# Spec Delta

## Purpose

Sends one polite follow-up to the employer when an application has gone unanswered for a week, so the user does not have to track who to nudge and when.

## ADDED Requirements

### Requirement: Single follow-up after seven days
The system SHALL send one follow-up email per application seven days after the application was submitted, only if the application is still Applied and has no linked inbound thread, and SHALL never send a second follow-up for the same application.

#### Scenario: Unanswered application reaches seven days
- **WHEN** an application was submitted seven days ago, is still Applied, and has no linked thread
- **THEN** one follow-up email is sent to the employer contact used for the application, the sent message is stored against the application, and the application records the follow-up timestamp

#### Scenario: Employer already replied
- **WHEN** an application reaches seven days but has a linked thread of any classification
- **THEN** no follow-up is sent

#### Scenario: Follow-up already sent
- **WHEN** the follow-up scheduler runs again for an application that already has a follow-up timestamp
- **THEN** no further follow-up is sent

#### Scenario: Application no longer Applied
- **WHEN** an application reaches seven days but its status is Pending, Interviewing, Offer or Closed
- **THEN** no follow-up is sent

### Requirement: Follow-up content rules
The system SHALL generate the follow-up from the application's company, title and submission date, SHALL contain no new claims about the user's experience, and SHALL pass the outgoing-mail content guard before sending.

#### Scenario: Generated follow-up references the application
- **WHEN** a follow-up is generated for an application
- **THEN** the message names the role and company, states when the application was submitted, and contains no statement about the user's experience that is absent from the submitted application

#### Scenario: Generated follow-up would violate the content guard
- **WHEN** the generated follow-up text contains a dollar sign or the words salary, compensation or equity
- **THEN** the message is not sent, the block is written to the activity log, and the follow-up is not marked as sent

### Requirement: No follow-up contact available
The system SHALL skip the follow-up when no employer email contact is known for the application and SHALL record why.

#### Scenario: Application has no contact address
- **WHEN** an application reaches seven days and no recruiter or employer address is known for it
- **THEN** no email is sent, the follow-up is marked skipped with reason "no contact", and the application appears in the next digest as unfollowed
