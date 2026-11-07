# Spec Delta

## Purpose

Creates and keeps the per-ATS accounts that some employers require before an application can be submitted, so account walls do not stop the agent and the user never has to manage those credentials.

## ADDED Requirements

### Requirement: Account is created only when the ATS requires one
The system SHALL detect when an application form requires an account and SHALL create one only then, using the user's Gmail address and a generated password of at least 20 characters.

#### Scenario: Form requires sign-up
- **WHEN** the application page requires creating an account before applying
- **THEN** an account is created with the user's Gmail address, the activity log records "account-created" for that ATS and company, and the application continues

#### Scenario: Form does not require an account
- **WHEN** the application form can be submitted without an account
- **THEN** no account is created

### Requirement: Credentials are stored in the vault
The system SHALL store each ATS credential encrypted in the tenant's credential vault, keyed by user, ATS and company, and SHALL never write the password to logs, the activity log, or the application record.

#### Scenario: Credential stored
- **WHEN** an account is created
- **THEN** a vault entry exists for that user, ATS and company, and the plaintext password appears nowhere outside the vault

### Requirement: Existing credentials are reused
The system SHALL reuse a stored credential when the same user applies again through the same ATS and company, and SHALL not create a second account.

#### Scenario: Second application at the same company
- **WHEN** a user applies to a second job at a company where a credential already exists
- **THEN** the agent signs in with the stored credential instead of registering

#### Scenario: Stored credential rejected
- **WHEN** sign-in with the stored credential fails
- **THEN** the application is marked PENDING with reason "credential-rejected", the vault entry is flagged, and no new account is created automatically

### Requirement: Email verification is completed from Gmail
When account creation sends a verification link or one-time code to the user's Gmail, the system SHALL read it through the user's Gmail connection and complete verification within the same session.

#### Scenario: Verification link arrives
- **WHEN** a verification email from the ATS arrives within 5 minutes of sign-up
- **THEN** the link is followed or the code entered, and the activity log records "account-verified"

#### Scenario: Verification email does not arrive
- **WHEN** no verification email arrives within 5 minutes
- **THEN** the application is marked PENDING with reason "verification-timeout" and the account creation is retried on the next run
