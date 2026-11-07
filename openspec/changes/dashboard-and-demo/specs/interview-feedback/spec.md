# Spec Delta

## Purpose

Captures how each interview went, in the candidate's own words plus any feedback the interviewer shared, and keeps it with the application for later use.

## ADDED Requirements

### Requirement: Feedback form per interview
Each interview on a card in Interviewing or later SHALL have a feedback form with free-text fields for the candidate's own notes and for feedback relayed from the interviewer, plus an overall rating from 1 to 5.

#### Scenario: Form available after interview
- **WHEN** the user opens a card with a booked interview
- **THEN** the card offers a feedback form for that interview with notes, relayed feedback and rating fields

#### Scenario: Feedback link from reminder
- **WHEN** the user follows the feedback link in a post-interview reminder
- **THEN** the feedback form for that specific interview opens

### Requirement: Feedback is stored against the application
Submitting the form SHALL store the feedback with the interview and application, timestamped, and SHALL record an activity log entry with actor user. Feedback SHALL be editable afterwards, keeping the latest version.

#### Scenario: Submit feedback
- **WHEN** the user submits notes and a rating for an interview
- **THEN** the feedback is saved on that interview, the activity log gains a user-actor entry, and the card detail shows the feedback

#### Scenario: Edit feedback
- **WHEN** the user edits previously submitted feedback
- **THEN** the stored feedback reflects the edit and keeps the original submission time plus an updated time

#### Scenario: Empty submission
- **WHEN** the user submits the form with no notes, no relayed feedback and no rating
- **THEN** the submission is rejected with a message asking for at least one field

### Requirement: Feedback is not acted on
The agent SHALL NOT change decisions, resumes or prep plans based on stored feedback in this release. Feedback is stored for later use only.

#### Scenario: Feedback does not alter behavior
- **WHEN** feedback with a low rating is stored for an application
- **THEN** no decision, resume or follow-up behavior for other applications changes as a result
