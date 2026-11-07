# Spec Delta

## Purpose

Provides a demo-only employer side so the full loop, from application to a booked interview, can be shown within minutes on a seeded tenant.

## ADDED Requirements

### Requirement: Enabled only by tenant flag
The simulated recruiter SHALL run only for tenants whose demo flag is set. For any tenant without the flag it SHALL perform no action, send no mail and create no records.

#### Scenario: Flag off
- **WHEN** an application is submitted for a tenant without the demo flag
- **THEN** the simulated recruiter does nothing for that application

#### Scenario: Flag cannot be set by a user
- **WHEN** a signed-in user attempts to set the demo flag on their own tenant through the web app or API
- **THEN** the request is refused and the flag is unchanged

### Requirement: Replies to applications on seeded jobs
For a flagged tenant, when an application on a seeded job reaches status applied, the simulated recruiter SHALL deliver an email to the user's mailbox within five minutes, from a recruiter identity for that company, proposing three interview time slots on upcoming weekdays.

#### Scenario: Reply after submission
- **WHEN** a seeded-job application for a flagged tenant becomes applied
- **THEN** within five minutes an email from that company's recruiter identity, referencing the job title, with three proposed slots is in the user's mailbox where inbox sync will read it

#### Scenario: Non-seeded job on a flagged tenant
- **WHEN** an application for a flagged tenant is on a job that is not seeded
- **THEN** the simulated recruiter sends nothing for it

### Requirement: Accepts a confirmation
When the agent replies to the simulated recruiter's thread confirming one of the proposed slots, the simulated recruiter SHALL answer in the same thread acknowledging that slot within five minutes.

#### Scenario: Confirmation acknowledged
- **WHEN** the agent sends the confirmation reply for a proposed slot
- **THEN** an acknowledgement from the recruiter identity arrives in the same thread naming the confirmed slot

#### Scenario: Reply does not match a slot
- **WHEN** a reply in the thread names a time that was not proposed
- **THEN** the simulated recruiter answers that the time is unavailable and repeats the original three slots

### Requirement: Seeded demo data
A seed command SHALL create a demo tenant with the demo flag, a demo user with an approved profile, a set of seeded companies and jobs on the supported application surfaces, and at least one seeded job that triggers a CAPTCHA. Running the seed twice SHALL not duplicate data.

#### Scenario: Seed creates demo tenant
- **WHEN** the seed command runs on an empty database
- **THEN** a flagged demo tenant, a demo user with an approved profile, at least ten seeded jobs and one CAPTCHA-bearing job exist

#### Scenario: Seed is idempotent
- **WHEN** the seed command runs a second time
- **THEN** the counts of demo tenants, users, companies and jobs are unchanged

### Requirement: Simulated mail is marked
Every email the simulated recruiter sends SHALL carry a marker identifying it as simulated, so it can be told apart from real mail in logs and the activity log.

#### Scenario: Marker present
- **WHEN** the simulated recruiter sends any email
- **THEN** the message carries the simulated marker and the activity log entry for its arrival notes it as simulated
