# Spec Delta

## Purpose

Reads the user's connected mailbox on a schedule, links recruiter and employer threads to the application they belong to, classifies them, and moves the application's status so the board reflects what the employer actually said.

## ADDED Requirements

### Requirement: Hourly mailbox sync
The system SHALL read new messages from each user's connected mailbox at least once per hour and process only messages it has not processed before.

#### Scenario: New messages since last sync
- **WHEN** the hourly sync runs for a user and three messages arrived since the previous sync
- **THEN** exactly those three messages are processed and the sync's high-water mark advances past them

#### Scenario: Sync is re-run for the same window
- **WHEN** the hourly sync runs twice for the same user with no new mail in between
- **THEN** no message is processed twice and no duplicate thread rows are created

#### Scenario: Mailbox access token is invalid
- **WHEN** the mailbox rejects the user's access credentials during sync
- **THEN** the sync records a failure in the activity log, leaves the high-water mark unchanged, marks the user's mailbox connection as needing re-authorization, and does not retry within the same run

### Requirement: Thread linking to applications
The system SHALL link an inbound thread to exactly one of the user's applications when the sender domain or message content identifies the company and the message references the job title or a known application identifier, and SHALL leave it unlinked otherwise.

#### Scenario: Sender domain and title match one application
- **WHEN** a message arrives from a company domain and mentions the job title of one of the user's applications
- **THEN** the thread is linked to that application and an `email_threads` row is created with the thread's provider id

#### Scenario: Company matches several applications
- **WHEN** a message matches the company of two applications and the title of only one
- **THEN** the thread is linked to the application whose title matches

#### Scenario: No application matches
- **WHEN** a message cannot be matched to any application by company and title
- **THEN** no thread row is created, the message is marked processed, and no status changes

#### Scenario: Thread already linked
- **WHEN** a new message arrives on a thread that already has an `email_threads` row
- **THEN** the existing row's last-message timestamp is updated and no second row is created

### Requirement: Thread classification
The system SHALL classify each linked thread as one of confirmation, rejection, interview, offer, or other, and SHALL record the classification on the thread row.

#### Scenario: Application received message
- **WHEN** a linked thread's latest message acknowledges receipt of the application
- **THEN** the thread is classified as confirmation

#### Scenario: Rejection message
- **WHEN** a linked thread's latest message states the employer is not moving forward
- **THEN** the thread is classified as rejection

#### Scenario: Interview invitation
- **WHEN** a linked thread's latest message proposes an interview or asks for availability
- **THEN** the thread is classified as interview

#### Scenario: Offer message
- **WHEN** a linked thread's latest message extends an offer of employment
- **THEN** the thread is classified as offer

#### Scenario: Unclassifiable message
- **WHEN** a linked thread's latest message fits none of the categories
- **THEN** the thread is classified as other and the application status is unchanged

### Requirement: Status transitions from classified mail
The system SHALL move an application's status when a linked thread is classified as rejection, interview or offer, and SHALL never move a status backwards or out of Closed.

#### Scenario: Rejection closes the application
- **WHEN** a thread linked to an Applied or Interviewing application is classified as rejection
- **THEN** the application status becomes Closed with closed reason "rejected" and the change is written to the activity log

#### Scenario: Interview invitation advances the application
- **WHEN** a thread linked to an Applied application is classified as interview
- **THEN** the application status becomes Interviewing

#### Scenario: Offer advances the application
- **WHEN** a thread linked to an Applied or Interviewing application is classified as offer
- **THEN** the application status becomes Offer

#### Scenario: Mail arrives for a closed application
- **WHEN** a thread linked to a Closed application is classified as interview or offer
- **THEN** the status stays Closed and the thread is flagged in the next digest for the user

#### Scenario: Confirmation does not change status
- **WHEN** a thread linked to an Applied application is classified as confirmation
- **THEN** the application status stays Applied and the application's last-activity timestamp is updated

### Requirement: Compensation thread detection
The system SHALL flag any linked thread whose latest inbound message asks about or states compensation, salary, equity or offer terms, and SHALL exclude flagged threads from every automated reply.

#### Scenario: Recruiter asks for salary expectations
- **WHEN** a linked thread's latest message asks what compensation the user expects
- **THEN** the thread is flagged as compensation, no automated reply is sent on that thread, and the thread appears in the user's next digest as needing their answer

#### Scenario: Offer with terms
- **WHEN** a thread classified as offer contains a salary figure
- **THEN** the thread is flagged as compensation in addition to its offer classification

### Requirement: Booking link detection
The system SHALL detect a self-service scheduling link in a linked thread and SHALL surface it to the user instead of opening it.

#### Scenario: Recruiter sends a booking link
- **WHEN** a linked thread's latest message contains a scheduling-page link rather than proposed times
- **THEN** the thread is flagged as booking-link, the link is included in the user's next digest, and no slot proposal or reply is generated by the system

### Requirement: Tenant isolation of mail data
The system SHALL store every thread row with the owning user's tenant and SHALL never link a thread to another tenant's application.

#### Scenario: Two tenants applied to the same company
- **WHEN** a message in tenant A's mailbox matches the company and title of an application in tenant B
- **THEN** the message is matched only against tenant A's applications and no row in tenant B is created or changed
