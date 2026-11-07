# Spec Delta

## Purpose

Keeps each customer's data separate: every record belongs to one tenant and no request can read or write another tenant's rows.

## ADDED Requirements

### Requirement: Every record belongs to one tenant
The system SHALL store a tenant identifier on every table that holds user, profile, job, application, credential or log data, and SHALL reject writes that omit it.

#### Scenario: Row written with the caller's tenant
- **WHEN** an authenticated request creates any record
- **THEN** the record is stored with the tenant id of the authenticated user, regardless of any tenant id supplied in the request body

#### Scenario: Write without a tenant is refused
- **WHEN** an internal code path attempts to insert a row with no tenant id
- **THEN** the database rejects the insert and the error is surfaced, not silently defaulted

### Requirement: Reads are scoped to the caller's tenant
The system SHALL return only rows belonging to the caller's tenant from every read, list and search endpoint.

#### Scenario: Cross-tenant read by id returns not found
- **WHEN** a user in tenant A requests a record by id that belongs to tenant B
- **THEN** the response is "not found", identical to the response for an id that does not exist

#### Scenario: List endpoints never include other tenants
- **WHEN** two tenants each hold records and a user in tenant A lists that record type
- **THEN** only tenant A's records are returned

### Requirement: Tenant is derived from the session, never from input
The system SHALL take the tenant for every request from the authenticated session and SHALL ignore any tenant id provided by the client.

#### Scenario: Forged tenant id in request body
- **WHEN** a request body or query string includes a tenant id different from the session's tenant
- **THEN** the supplied value is ignored and the operation runs against the session's tenant
