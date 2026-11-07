# Spec Delta

## Purpose

Decides, for each discovered posting, whether this user should apply, and orders the approved postings so the daily budget goes to the best ones.

## ADDED Requirements

### Requirement: One judgment per posting
The system SHALL produce for each candidate a structured judgment with fields: apply (true or false), rationale (text), pay_min, pay_max, location_mode (onsite, hybrid or remote), seniority, and application_deadline when stated, using the posting, the approved profile and the survey answers.

#### Scenario: Posting judged apply
- **WHEN** a posting is judged with the user's profile
- **THEN** the judgment contains apply=true, a rationale under 600 characters, and the extracted facts, with null for facts the posting does not state

#### Scenario: Judgment output malformed
- **WHEN** the judgment response does not match the required structure
- **THEN** the judgment is retried once and, if still malformed, the candidate is marked unjudged on the run record and excluded from ranking

### Requirement: No hard filters
The system SHALL NOT reject a posting by rule on pay, location or title; preferences influence the judgment only through the profile and survey content supplied to it.

#### Scenario: Posting below salary floor
- **WHEN** a posting states pay below the user's survey salary floor
- **THEN** the posting is still judged, and any skip is expressed in the rationale rather than by a filter

### Requirement: Judgments are reproducible across prompt versions
The system SHALL record the prompt version and model used with every judgment so decisions made under different versions can be compared.

#### Scenario: Prompt updated between runs
- **WHEN** the decision prompt version changes
- **THEN** judgments from the new run carry the new version and earlier run records keep the old one

### Requirement: Approved postings ranked
The system SHALL order postings judged apply=true by fit to the profile, using a stated application deadline as the tiebreaker so an earlier deadline ranks higher among equally fit postings.

#### Scenario: Equal fit, different deadlines
- **WHEN** two approved postings are judged equally fit and one closes tomorrow
- **THEN** the posting closing tomorrow ranks ahead of the other

#### Scenario: Deadline already passed
- **WHEN** a posting's stated deadline is before the run date
- **THEN** the posting is excluded from the ranked list and the exclusion reason is recorded

### Requirement: Daily target selects the top N
The system SHALL take the top N of the ranked list, where N is the user's configured daily target (default 12, minimum 1, maximum 30), and SHALL discard the remainder.

#### Scenario: More approved than target
- **WHEN** 25 postings are approved and the user's target is 12
- **THEN** exactly 12 are selected in rank order and the other 13 appear on the run record as not selected

#### Scenario: Target out of range
- **WHEN** a user sets a daily target of 50
- **THEN** the value is rejected and the previous target remains
