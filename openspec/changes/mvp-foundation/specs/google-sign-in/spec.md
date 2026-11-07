# Spec Delta

## Purpose

Lets a person sign in with their Google account in one consent step that also connects Gmail, Calendar and Drive for the agent to use on their behalf.

## ADDED Requirements

### Requirement: Sign in with Google creates the account
The system SHALL let a visitor sign in with Google, and on the first successful sign-in SHALL create a tenant and a user owned by that tenant, keyed by the Google account's verified email.

#### Scenario: First sign-in
- **WHEN** a visitor completes Google sign-in with an email that has no user
- **THEN** a new tenant and user are created, the user is signed in, and they land on onboarding

#### Scenario: Returning sign-in
- **WHEN** a visitor completes Google sign-in with an email that already has a user
- **THEN** no new tenant or user is created and the existing user is signed in

#### Scenario: Unverified Google email
- **WHEN** the Google account's email is not marked verified by Google
- **THEN** sign-in is refused with a message explaining why and no user is created

### Requirement: One consent grants the agent's Google access
The sign-in consent SHALL request Gmail read and send, Calendar read and write, and Drive read, and the system SHALL store the resulting tokens in the credential vault for that user.

#### Scenario: All scopes granted
- **WHEN** the user approves the consent screen with every requested scope
- **THEN** the refresh token and granted scopes are stored in the vault and the connections page shows Gmail, Calendar and Drive as connected

#### Scenario: User declines a scope
- **WHEN** the user approves sign-in but removes one or more requested scopes
- **THEN** the user is signed in, the missing scopes are listed on the connections page, and the agent treats those sources as not connected

### Requirement: Sessions expire and can be ended
The system SHALL keep the user signed in with a session that expires after 30 days of inactivity and SHALL provide a sign-out that ends it immediately.

#### Scenario: Sign out
- **WHEN** a signed-in user chooses sign out
- **THEN** the session is invalidated and subsequent requests with it are treated as unauthenticated

#### Scenario: Expired session
- **WHEN** a request arrives with a session unused for more than 30 days
- **THEN** the request is treated as unauthenticated and the user is sent to sign in

### Requirement: Revoked Google access is detected
The system SHALL detect when Google reports the stored token as revoked or invalid, mark the affected sources as disconnected, and tell the user to reconnect.

#### Scenario: Token revoked at Google
- **WHEN** a Google API call fails because the stored refresh token is revoked
- **THEN** Gmail, Calendar and Drive are marked disconnected, an activity log entry is written, and the user sees a reconnect prompt on next visit
