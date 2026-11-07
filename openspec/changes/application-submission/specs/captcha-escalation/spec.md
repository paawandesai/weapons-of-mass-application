# Spec Delta

## Purpose

Resolves CAPTCHA challenges met during submission through two automated attempts and then the user, with a bounded hold, so CAPTCHAs delay an application rather than silently dropping it and the user is interrupted only as a last resort.

## ADDED Requirements

### Requirement: CAPTCHA is detected and recorded
The system SHALL detect a CAPTCHA challenge on an application form, capture the challenge image, and create a captcha request record linked to the application before attempting to solve it.

#### Scenario: Challenge appears
- **WHEN** a CAPTCHA blocks the form during filling or submit
- **THEN** a captcha request exists with the image stored in the file store, stage "agent1", and the activity log records "captcha-detected"

### Requirement: Stage one is an automated solver with three attempts
The system SHALL first attempt to solve the challenge with an automated solver, up to three attempts, and SHALL proceed with the submission as soon as an attempt is accepted.

#### Scenario: Solved on second attempt
- **WHEN** the first attempt is rejected and the second is accepted
- **THEN** the captcha request is marked resolved by "agent1", the submission continues, and the activity log records the stage and attempt count

#### Scenario: Three attempts rejected
- **WHEN** all three stage-one attempts are rejected
- **THEN** the captcha request advances to stage "agent2"

### Requirement: Stage two is an independent solver with three attempts
The system SHALL hand an unsolved challenge to a second solver that does not share the first solver's prompt or prior attempts, up to three attempts.

#### Scenario: Three stage-two attempts rejected
- **WHEN** all three stage-two attempts are rejected
- **THEN** the captcha request advances to stage "human"

### Requirement: Stage three asks the user by email
The system SHALL email the user the current challenge image with a link to a reply form, SHALL hold the browser session open, and SHALL apply the user's reply to the held session.

#### Scenario: User replies in time
- **WHEN** the user submits the reply form within 15 minutes of the email
- **THEN** the reply is entered into the held session, and if accepted the captcha request is marked resolved by "human" and the submission continues

#### Scenario: Reply link is reused or expired
- **WHEN** a reply form is submitted after the hold ended or for a request already resolved
- **THEN** the reply is rejected with a message that the request is no longer open, and nothing is entered into any session

### Requirement: Timeout parks the application
If no accepted answer arrives within 15 minutes of the human request, the system SHALL close the browser session, mark the application PENDING with reason "captcha-timeout", and retry on the next run.

#### Scenario: No reply
- **WHEN** 15 minutes pass without a reply
- **THEN** the session is closed, the application is PENDING with reason "captcha-timeout", the captcha request is marked expired, and the digest lists it

### Requirement: Every escalation is logged with the resolving stage
The system SHALL record on the captcha request which stage resolved it, how many attempts each stage used, and the timestamps, and SHALL expose that on the application's activity.

#### Scenario: Reporting
- **WHEN** the user opens an application that hit a CAPTCHA
- **THEN** the activity shows the stage that resolved it and the attempt counts per stage
