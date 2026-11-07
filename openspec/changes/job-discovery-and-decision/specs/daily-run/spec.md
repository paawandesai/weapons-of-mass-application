# Spec Delta

## Purpose

Runs discovery, decision and hand-off once per user per day as a stateless pass, and records enough about each run for the run view, digest and audit.

## ADDED Requirements

### Requirement: One scheduled run per user per day
The system SHALL start one run per active user per day at the user's configured run hour, and SHALL NOT start a second scheduled run for the same user on the same day.

#### Scenario: Scheduled trigger
- **WHEN** the user's configured run hour arrives
- **THEN** a run starts for that user and is recorded with a start time and the user's daily target

#### Scenario: Run already happened today
- **WHEN** the scheduler fires for a user who already has a completed run today
- **THEN** no new run starts and the skip is recorded

### Requirement: Run gated on approved profile
The system SHALL NOT run discovery or decision for a user whose profile is not approved.

#### Scenario: Profile pending approval
- **WHEN** a run is triggered for a user with an unapproved profile
- **THEN** the run ends immediately with status `skipped_no_profile` and no sources are fetched

### Requirement: Run is stateless between days
The system SHALL fetch fresh postings on every run and SHALL NOT carry candidates from a previous run; a posting skipped yesterday may be judged again today.

#### Scenario: Posting skipped yesterday
- **WHEN** a posting judged skip on day 1 is still open on day 2
- **THEN** it is judged again on day 2 with no reference to the day 1 judgment

### Requirement: Hand-off of selected candidates
The system SHALL hand off the selected top N as an ordered list where each entry carries the posting fields, the judgment and the rank, and SHALL create a jobs row and an application row with status PENDING for each entry at hand-off.

#### Scenario: Hand-off creates rows
- **WHEN** a run selects 12 candidates
- **THEN** 12 jobs rows and 12 PENDING application rows exist for the user, each linked to the run, before any submission starts

#### Scenario: Hand-off interrupted
- **WHEN** the process fails after creating 5 of 12 rows
- **THEN** the run is marked failed, the 5 created rows remain and are picked up by submission, and the run can be re-triggered manually to continue without duplicating them

### Requirement: Short day reported
The system SHALL complete a run that finds fewer approved postings than the daily target by handing off all of them and marking the run as a short day with the shortfall count.

#### Scenario: Four approved, target twelve
- **WHEN** only 4 postings are approved for a target of 12
- **THEN** 4 are handed off and the run record shows short_day=true with shortfall 8

### Requirement: Run record readable by run view and digest
The system SHALL store, for each run: status, start and end time, per-source fetch results, counts of fetched, deduped, judged, approved and selected postings, and for every judged posting its title, company, URL, judgment, rank and whether it was selected.

#### Scenario: Run view reads a completed run
- **WHEN** a run completes
- **THEN** the run record lists every judged posting with its rationale and selection outcome, in rank order, and the counts add up to the fetched total

#### Scenario: Run failed mid-way
- **WHEN** a run fails during judgment
- **THEN** the run record has status `failed`, the error, and the partial results gathered so far

### Requirement: Manual run trigger
The system SHALL let a user trigger a run on demand, subject to the same profile gate and dedupe rules, so a second run on the same day produces no duplicate applications.

#### Scenario: Manual run after scheduled run
- **WHEN** the user triggers a run after today's scheduled run completed
- **THEN** the run proceeds, every posting already handed off today is dropped by dedupe, and no duplicate application rows are created

### Requirement: Run outcomes written to the activity log
The system SHALL write a run start and a run end entry to the activity log for the user, and one entry per hand-off.

#### Scenario: Run completes
- **WHEN** a run ends in any status
- **THEN** the activity log holds a start entry and an end entry with the status and counts
