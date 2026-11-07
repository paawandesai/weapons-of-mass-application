# Spec Delta

## Purpose

Provides the audit trail of everything the agent did on a user's behalf, so the user can see and trust every action taken without their review.

## ADDED Requirements

### Requirement: Every agent action is logged
The system SHALL write an activity log entry for every action taken on a user's behalf, recording time, actor (agent or user), action name, and structured detail, and optionally the application it concerns.

#### Scenario: Agent action logged
- **WHEN** the agent completes or fails any action (profile build, approval check, token refresh, later: application, email send)
- **THEN** an entry with the action name, outcome and relevant ids is written before the action is reported as done

#### Scenario: User action logged
- **WHEN** the user approves a profile, disconnects a source, or edits survey answers
- **THEN** an entry with actor "user" is written

### Requirement: Log is append-only
The system SHALL not allow activity log entries to be edited or deleted through any application code path.

#### Scenario: Update attempted
- **WHEN** code attempts to update or delete an activity log row
- **THEN** the database refuses the statement

### Requirement: Log is readable per user and per application
The system SHALL let a signed-in user read their own activity log in reverse chronological order, and filter it to a single application.

#### Scenario: Read own log
- **WHEN** the user opens their activity view
- **THEN** entries for that user are listed newest first with time, actor, action and a readable summary of the detail

#### Scenario: Read another user's log
- **WHEN** a user requests the log of a user in another tenant
- **THEN** the response is not found

### Requirement: Log entries never contain secrets
The activity log SHALL store references to credentials, never credential values, tokens or passwords.

#### Scenario: Token refresh logged
- **WHEN** a Google token is refreshed and the event is logged
- **THEN** the entry records the provider and outcome only, with no token material
