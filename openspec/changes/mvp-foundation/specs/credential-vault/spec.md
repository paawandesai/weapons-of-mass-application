# Spec Delta

## Purpose

Stores Google tokens and ATS account passwords encrypted at rest with keys separated per tenant, so a database read alone exposes nothing usable.

## ADDED Requirements

### Requirement: Secrets are encrypted per tenant
The system SHALL encrypt every stored secret with a data key unique to its tenant, and SHALL store that data key only in wrapped form under a master key held outside the database.

#### Scenario: Secret stored
- **WHEN** a Google refresh token or ATS password is saved
- **THEN** the database row contains only ciphertext and a reference to the tenant's wrapped data key; the plaintext never appears in the database

#### Scenario: Master key missing
- **WHEN** the service starts without the master key configured
- **THEN** the service refuses to start and reports the missing configuration

### Requirement: Secrets are read only through the vault
The system SHALL expose secrets to application code only through a vault interface that decrypts on demand for the caller's tenant and never returns secrets in API responses.

#### Scenario: Decrypt for own tenant
- **WHEN** a worker acting for tenant A requests a secret belonging to tenant A
- **THEN** the plaintext is returned to the worker in memory only

#### Scenario: Decrypt across tenants
- **WHEN** code acting for tenant A requests a secret belonging to tenant B
- **THEN** the request fails and is logged

#### Scenario: Secret in API response
- **WHEN** any API endpoint returns a connection or credential record
- **THEN** the response contains identifiers, provider and timestamps only, never the secret value

### Requirement: Secrets are replaceable and deletable
The system SHALL let a secret be replaced (rotated) and deleted, and deletion SHALL make the value unrecoverable.

#### Scenario: Source disconnected
- **WHEN** a user disconnects a source whose credential lives in the vault
- **THEN** the secret row is deleted and later reads for it fail

#### Scenario: Token refreshed
- **WHEN** Google issues a new refresh token
- **THEN** the stored ciphertext is replaced and the old value is no longer retrievable

### Requirement: Vault access is logged
The system SHALL write an activity log entry for every secret creation, rotation and deletion, and for every failed decrypt.

#### Scenario: Failed decrypt
- **WHEN** a decrypt fails for any reason
- **THEN** an activity log entry records the secret id, tenant and failure reason, with no secret material
