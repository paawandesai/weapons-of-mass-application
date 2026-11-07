# Spec Delta

## Purpose

Gives the user one explicit review and approval of the agent-built profile, and holds every autonomous action until that approval exists.

## ADDED Requirements

### Requirement: Profile is presented for review
The system SHALL show the built profile as an editable form, section by section, with each flagged conflict and partial source called out.

#### Scenario: Review page after build
- **WHEN** a profile build completes
- **THEN** the user is shown every section with editable fields and a list of items flagged during the build

#### Scenario: Edits saved
- **WHEN** the user changes any field and saves
- **THEN** a new profile version is stored with the edits and the review page shows the saved values

### Requirement: Approval is explicit and recorded
The system SHALL record profile approval only when the user takes an explicit approve action, storing the approved version and timestamp.

#### Scenario: User approves
- **WHEN** the user clicks approve on the review page
- **THEN** the profile's approved version and approval time are stored and an activity log entry is written

#### Scenario: Approval blocked by unresolved conflicts
- **WHEN** the user clicks approve while a flagged date conflict is unresolved
- **THEN** approval is refused and the unresolved items are listed

### Requirement: No autonomous action before approval
The system SHALL refuse to run discovery, applications, email sends or any other agent action for a user whose profile has no approved version.

#### Scenario: Run requested before approval
- **WHEN** a daily run or any agent task is scheduled for a user without an approved profile
- **THEN** the task exits without acting and records "profile not approved" in the activity log

### Requirement: Rebuild after approval requires re-approval
When a profile is rebuilt from sources after approval, the system SHALL keep acting on the last approved version until the user approves the new one.

#### Scenario: Rebuild while approved
- **WHEN** the user triggers a rebuild on an approved profile
- **THEN** the new version is marked pending review, downstream actions continue to use the approved version, and the user is prompted to review
