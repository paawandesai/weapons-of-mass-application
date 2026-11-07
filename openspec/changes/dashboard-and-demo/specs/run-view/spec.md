# Spec Delta

## Purpose

Shows the user what the daily run is doing right now: which postings it considered, how it ranked them and what it decided, without turning that list into stored state.

## ADDED Requirements

### Requirement: Show the current or latest run
The run view SHALL show the user's in-progress daily run, or the most recent completed run when none is in progress, with its start time, status and the number of postings considered, approved and applied to.

#### Scenario: Run in progress
- **WHEN** the user opens the run view while a daily run is executing for them
- **THEN** the view shows that run with its start time, a running status and counts that update as the run proceeds

#### Scenario: No run yet
- **WHEN** a user whose profile is approved but who has never had a run opens the run view
- **THEN** the view states that no run has happened yet and shows when the next one is scheduled

### Requirement: Ranked candidates with rationale
The run view SHALL list the postings the run judged, in rank order, each with company, title, the apply or skip verdict, the rationale text and, for the top N, the outcome of the submission attempt.

#### Scenario: Candidates listed in rank order
- **WHEN** a run judged twelve postings and approved eight
- **THEN** the view lists all twelve in rank order, marks the eight approved, and shows the submission outcome for those attempted

#### Scenario: Skipped posting shows why
- **WHEN** a posting was judged with verdict skip
- **THEN** its row shows the skip verdict and the rationale the decision produced

### Requirement: Run view is ephemeral
Run records SHALL be retained for display for seven days and then discarded. Postings listed in the run view that were not applied to SHALL NOT become applications, jobs or any other persistent record.

#### Scenario: Old runs expire
- **WHEN** a run is older than seven days
- **THEN** it no longer appears in the run view and its candidate list is gone

#### Scenario: Skipped postings leave no trace
- **WHEN** a run finishes having skipped a posting
- **THEN** no job or application row exists for that posting and the board does not show it

### Requirement: Run view is tenant-scoped
The run view SHALL show only runs belonging to the signed-in user.

#### Scenario: Another user's run
- **WHEN** another user in a different tenant has a run in progress
- **THEN** the signed-in user's run view does not show it
