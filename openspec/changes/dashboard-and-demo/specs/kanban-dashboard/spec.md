# Spec Delta

## Purpose

Gives the user a live board of every application by stage, with the detail behind each card and the ability to move cards themselves.

## ADDED Requirements

### Requirement: Board columns
The dashboard SHALL show the user's applications in four columns: Applied, Interviewing, Offer and Closed, mapped from the application status. Applications in status PENDING SHALL appear in the Applied column with a PENDING badge rather than in a column of their own.

#### Scenario: Statuses map to columns
- **WHEN** a user with applications in statuses pending, applied, interviewing, offer and closed opens the dashboard
- **THEN** each application appears once, in the column for its status, and the pending one is in Applied with a PENDING badge

#### Scenario: Empty board
- **WHEN** a user with no applications opens the dashboard
- **THEN** all four columns render empty and no error is shown

### Requirement: Card summary fields
Each card SHALL show company, job title, location mode (onsite, hybrid or remote), posted pay range, date applied and the time of the last activity on the application.

#### Scenario: Card renders known fields
- **WHEN** an application has a posted pay range and a date applied
- **THEN** its card shows company, title, location mode, the pay range, the date applied and last activity time

#### Scenario: Missing posted pay
- **WHEN** the job for an application has no posted pay range
- **THEN** the card shows the pay field as not listed and renders without error

### Requirement: Card detail
Opening a card SHALL show the tailored resume, the form answers given at submission, the linked email thread, the activity log for the application and the prep plan when one exists.

#### Scenario: Full detail
- **WHEN** the user opens a card for an application that was submitted and has an email thread
- **THEN** the detail view shows the resume document, every form answer, the thread messages and the activity log entries in time order

#### Scenario: No prep plan yet
- **WHEN** the user opens a card for an application without a booked interview
- **THEN** the prep plan section states there is no plan yet and the rest of the detail renders

### Requirement: User moves a card
The user SHALL be able to move a card to any column. The move SHALL set the application status to the target column's status, record an override in the activity log with actor user, and take effect immediately on the board.

#### Scenario: Drag to Closed
- **WHEN** the user moves a card from Applied to Closed
- **THEN** the application status becomes closed, the activity log gains a user-actor entry naming the previous and new stage, and the card appears in Closed

#### Scenario: Move fails to save
- **WHEN** the user moves a card and the save fails
- **THEN** the card returns to its previous column and the user sees an error message

### Requirement: Agent respects user moves
The agent SHALL NOT change the status of an application the user moved to Closed, and SHALL NOT send follow-ups, schedule or otherwise act on it.

#### Scenario: Closed card ignored by follow-ups
- **WHEN** the follow-up schedule would send a message for an application the user moved to Closed
- **THEN** no message is sent and the application stays closed

#### Scenario: Recruiter reply on a closed card
- **WHEN** a recruiter email arrives for an application the user closed
- **THEN** the thread is linked to the application and surfaced in the digest, but the status stays closed

### Requirement: Tenant isolation on dashboard reads
Every dashboard read SHALL be scoped to the signed-in user's tenant. A request for a card belonging to another tenant SHALL be refused as not found.

#### Scenario: Cross-tenant card request
- **WHEN** a signed-in user requests the card detail for an application id that belongs to another tenant
- **THEN** the response is not found and no data from the other tenant is returned

#### Scenario: Board lists only own tenant
- **WHEN** two tenants each have applications and one user opens the dashboard
- **THEN** only that user's tenant's applications appear
