# Spec Delta

## Purpose

Fetches the current postings a run should consider from every configured source and drops the ones this user has already applied to, holding nothing between runs.

## ADDED Requirements

### Requirement: Postings fetched from resolved ATS boards
The system SHALL fetch current postings from every resolved board in the user's company list via the Ashby, Greenhouse and Lever public APIs, capturing title, description, location, posted pay range if present, ATS job id, canonical URL and posted date.

#### Scenario: Board returns postings
- **WHEN** a run fetches a resolved Greenhouse board with 30 open postings
- **THEN** all 30 are returned as candidates with the captured fields and ATS `greenhouse`

#### Scenario: Board fetch fails
- **WHEN** a board API times out or returns an error
- **THEN** that board is skipped for this run, the failure is recorded on the run, and fetching continues for the remaining boards

### Requirement: Postings discovered from HN Who is hiring
The system SHALL parse the current month's Hacker News "Who is hiring" thread into candidate postings, keeping only comments that link to an Ashby, Greenhouse or Lever application URL.

#### Scenario: Comment links to a supported ATS
- **WHEN** a thread comment contains a Lever job URL
- **THEN** a candidate is created from the comment text with ATS `lever` and the linked URL

#### Scenario: Comment has no supported link
- **WHEN** a thread comment links only to a company careers page or email address
- **THEN** no candidate is created from that comment

### Requirement: Best-effort LinkedIn public search
The system SHALL attempt public LinkedIn job searches derived from the profile and map results to supported ATS URLs where the posting links to one; failures or empty results SHALL NOT fail the run.

#### Scenario: LinkedIn blocks the request
- **WHEN** a LinkedIn public search returns a login wall or rate-limit response
- **THEN** the source is marked unavailable on the run record and discovery continues with the other sources

### Requirement: Already applied postings are dropped
The system SHALL drop any candidate that matches an existing application row for the same user by ATS job id or by normalized URL before judgment.

#### Scenario: Second run on the same day
- **WHEN** a run fetches a posting the user already has an application row for
- **THEN** the posting is dropped before judgment and is not counted in the run's judged total

#### Scenario: Same posting under two URLs
- **WHEN** a posting appears once with tracking parameters and once without
- **THEN** URL normalization treats them as one and only one candidate survives

### Requirement: Candidates within one run are deduplicated
The system SHALL collapse candidates that refer to the same posting across sources into one candidate that keeps the ATS API version of the data when available.

#### Scenario: Same job from board and HN
- **WHEN** a posting is fetched from the Ashby board and also linked from an HN comment
- **THEN** one candidate remains, carrying the Ashby board fields

### Requirement: Skipped postings are not stored
The system SHALL NOT persist candidate postings beyond the run record; a posting becomes a job row only when the daily run hands it off for submission.

#### Scenario: Posting judged skip
- **WHEN** a candidate is judged skip or falls outside the top N
- **THEN** no jobs row exists for it after the run, and only the run record retains its title, URL and rationale
