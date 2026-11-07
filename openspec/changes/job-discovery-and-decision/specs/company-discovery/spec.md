# Spec Delta

## Purpose

Maintains, per user, the list of companies whose public ATS boards the agent searches, generated from the profile and editable by the user.

## ADDED Requirements

### Requirement: Company list generated from the approved profile
The system SHALL generate an initial company list for a user from their approved profile and survey, producing at least 20 candidate company names, each tagged with the reason it was suggested.

#### Scenario: First generation after profile approval
- **WHEN** a user's profile is approved and the user has no company list
- **THEN** the system generates a list of at least 20 candidate companies with a one-line reason each and stores it for the user

#### Scenario: Profile not yet approved
- **WHEN** company generation is requested for a user whose profile is not approved
- **THEN** the system does not generate a list and records the reason in the activity log

### Requirement: Company resolved to an ATS board
The system SHALL resolve each candidate company to zero or more public boards on Ashby, Greenhouse or Lever by checking each ATS's public API, and SHALL keep only companies with at least one resolved board.

#### Scenario: Company has a Greenhouse board
- **WHEN** a candidate company's slug returns a public board on Greenhouse
- **THEN** the company is stored with ATS `greenhouse` and that board slug

#### Scenario: Company has no board on any supported ATS
- **WHEN** no ATS returns a public board for any slug variant of the company name
- **THEN** the company is marked unresolved, is excluded from job discovery, and the user can see it was dropped

#### Scenario: ATS API unavailable during resolution
- **WHEN** an ATS API times out or returns a server error while resolving a company
- **THEN** the company is left unresolved for that attempt and is retried on the next generation or run, without failing the whole list

### Requirement: Resolved boards are cached and shared across users
The system SHALL cache resolved company boards globally so that a company resolved for one user is not re-resolved for another, while membership in a user's list stays per user.

#### Scenario: Second user suggests an already resolved company
- **WHEN** company generation for user B produces a company already resolved for user A
- **THEN** the cached board is reused and no ATS lookup is made

### Requirement: User can add a company
The system SHALL let a user add a company by name or by ATS board URL, resolving it the same way as generated companies.

#### Scenario: Add by board URL
- **WHEN** the user submits a valid Ashby, Greenhouse or Lever board URL
- **THEN** the company is added to the user's list with the ATS and slug parsed from the URL, without an LLM call

#### Scenario: Add a company that cannot be resolved
- **WHEN** the user adds a company name that resolves to no supported board
- **THEN** the system rejects the addition with a message naming the three supported ATSs

### Requirement: User can remove a company
The system SHALL let a user remove a company from their list, after which no postings from that company are discovered for that user, and SHALL record the removal as a user override.

#### Scenario: Remove then run
- **WHEN** the user removes a company and a daily run occurs
- **THEN** no postings from that company's board are fetched or judged for that user, and the removal appears in the activity log as a user action

### Requirement: Company list grows over time
The system SHALL allow regeneration that appends new companies to a user's list without removing user-added ones or re-adding user-removed ones.

#### Scenario: Regeneration respects removals
- **WHEN** regeneration suggests a company the user previously removed
- **THEN** that company is not re-added to the user's list
