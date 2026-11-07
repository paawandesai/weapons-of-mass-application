# Spec Delta

## Purpose

Builds and maintains the single master profile document that every downstream decision, resume and form answer is drawn from, out of sources the user chooses to connect.

## ADDED Requirements

### Requirement: Sources can be connected
The system SHALL let a user connect these profile sources: a resume file (PDF or DOCX), a LinkedIn public profile URL, a GitHub username, and one or more Google Drive folders.

#### Scenario: Resume uploaded
- **WHEN** the user uploads a PDF or DOCX resume under 10 MB
- **THEN** the file is stored for the user and listed as a connected source with its upload time

#### Scenario: Unsupported resume file
- **WHEN** the user uploads a file that is not PDF or DOCX, or is over 10 MB
- **THEN** the upload is refused with the reason and no source is created

#### Scenario: Drive folders chosen
- **WHEN** Drive is connected and the user selects folders
- **THEN** only the selected folders are recorded as in scope for profile building

### Requirement: Sources can be disconnected
The system SHALL let a user disconnect any source, after which the agent SHALL make no further reads from it.

#### Scenario: Disconnect a source
- **WHEN** the user disconnects a connected source
- **THEN** the source is marked disconnected, its stored credentials or file are deleted, and the next profile build does not read it

### Requirement: Profile is built from connected sources
The system SHALL assemble one profile document per user from the connected sources, with sections for identity, contact, work history, projects, skills, education, preferences, survey answers and standard form answers.

#### Scenario: Build after sources connect
- **WHEN** the user has at least a resume connected and requests a profile build
- **THEN** a profile document is produced with every section present, each work history entry carrying employer, title and dates, and the build is recorded in the activity log

#### Scenario: Source partially readable
- **WHEN** a connected source returns only partial data (for example a LinkedIn page that shows only headline and current role)
- **THEN** the build uses what was returned, records which source was partial, and still completes

#### Scenario: No sources connected
- **WHEN** the user requests a build with no connected sources
- **THEN** the build is refused with a message naming the minimum (a resume) and no document is created

### Requirement: Profile never contains invented facts
The profile build SHALL include only employers, titles, dates, degrees and skills that appear in at least one connected source, and SHALL record for each work history entry which source it came from.

#### Scenario: Provenance recorded
- **WHEN** a profile is built
- **THEN** each work history entry, project and degree lists the source it was taken from

#### Scenario: Conflicting dates between sources
- **WHEN** two sources give different dates for the same role
- **THEN** the profile keeps the resume's dates and flags the conflict for the user to resolve in review

### Requirement: Profile is versioned
The system SHALL store each saved profile as a new version and SHALL keep prior versions readable.

#### Scenario: Rebuild creates a new version
- **WHEN** a profile is rebuilt or edited and saved
- **THEN** the version number increments, the prior version remains retrievable, and the current version is the one downstream reads
