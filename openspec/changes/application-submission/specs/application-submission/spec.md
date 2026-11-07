# Spec Delta

## Purpose

Fills and submits the hosted application form for one job on the user's behalf, confirms the outcome, and tracks the application through PENDING and APPLIED with a bounded retry, so the daily run reliably ends in recorded applications.

## ADDED Requirements

### Requirement: Accepts the daily-run hand-off
The system SHALL accept, for each of the day's top-N jobs, the job record, the decision facts and the user's approved profile, and SHALL create the job row and an application row in PENDING before any browser work starts.

#### Scenario: Hand-off received
- **WHEN** the daily run hands over a job for a user
- **THEN** a job row exists for that posting, an application row exists for the user in PENDING, and the activity log records "submission-started"

#### Scenario: Duplicate hand-off
- **WHEN** a hand-off arrives for a job that already has an application row for the same user
- **THEN** no second application is created and the hand-off is logged as a duplicate

### Requirement: Supports Ashby, Greenhouse and Lever forms only
The system SHALL submit applications only on application forms hosted by Ashby, Greenhouse or Lever, and SHALL refuse any other application URL.

#### Scenario: Unsupported ATS
- **WHEN** the job's application URL is not an Ashby, Greenhouse or Lever hosted form
- **THEN** the application is marked PENDING with reason "unsupported-ats", no browser session is opened, and the next run does not retry it

### Requirement: Form is filled from profile, resume and answers
The system SHALL fill the form using the profile's standard values, attach the tailored resume PDF, and enter the generated answers, then submit.

#### Scenario: Complete form
- **WHEN** every required field has a value and the resume is attached
- **THEN** the form is submitted

#### Scenario: Form structure not recognized
- **WHEN** a required field cannot be mapped to a profile value, a generated answer or the resume
- **THEN** the form is not submitted, the application is marked PENDING with reason "unmapped-field" naming the field, and a screenshot of the form is stored for diagnosis

### Requirement: Submission is confirmed before marking APPLIED
The system SHALL move an application to APPLIED only after observing an ATS confirmation page or a confirmation email, and SHALL record the confirmation source and timestamp.

#### Scenario: Confirmation page shown
- **WHEN** the ATS shows its confirmation page after submit
- **THEN** the application status becomes APPLIED with applied_at set and the activity log records "submitted" with source "page"

#### Scenario: No confirmation within the wait window
- **WHEN** neither a confirmation page nor a confirmation email is observed within 10 minutes of submit
- **THEN** the application stays PENDING with reason "unconfirmed" and is retried once on the next run

### Requirement: PENDING is the only in-flight state and retries once
A submission that fails or is parked SHALL remain PENDING with a recorded reason, SHALL be retried exactly once on the next daily run without re-judging the job, and SHALL be moved to CLOSED with reason "submission-failed" if the retry also fails.

#### Scenario: First failure
- **WHEN** a submission attempt fails for a retryable reason
- **THEN** the application is PENDING with that reason and attempt count 1, and it is not counted against the next run's daily target

#### Scenario: Second failure
- **WHEN** the retry of a PENDING application fails
- **THEN** the application is CLOSED with reason "submission-failed" and the digest lists it

### Requirement: Every step is written to the activity log
The system SHALL write an activity log entry for each step of a submission: start, account created, form filled, CAPTCHA stage, submitted, confirmed, failed, with the reason where applicable.

#### Scenario: Reading the trail
- **WHEN** the user opens an APPLIED application's activity
- **THEN** the entries show, in order, submission-started, form-filled, submitted and confirmed with timestamps
