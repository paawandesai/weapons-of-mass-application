# Spec Delta

## Purpose

Captures the preferences no connected source can reveal, so the agent's apply decisions reflect what the user actually wants.

## ADDED Requirements

### Requirement: Survey captures preferences in one page
The system SHALL present one survey page asking for target roles, salary floor, locations and remote preference, work-life balance priorities, family constraints, willingness to relocate, career direction, and daily application target.

#### Scenario: Survey completed
- **WHEN** the user submits the survey with every required field filled
- **THEN** the answers are stored on the profile's survey section and the user proceeds to profile review

#### Scenario: Required field missing
- **WHEN** the user submits with target roles or salary floor empty
- **THEN** the submission is rejected, the missing fields are highlighted, and already-entered answers are preserved

### Requirement: Daily application target is bounded
The survey SHALL accept a daily application target between 1 and 30 and SHALL default to 12 when the user leaves it unset.

#### Scenario: Default target
- **WHEN** the user submits without choosing a daily target
- **THEN** the stored target is 12

#### Scenario: Out-of-range target
- **WHEN** the user enters a daily target of 0 or above 30
- **THEN** the value is rejected with the allowed range shown

### Requirement: Survey answers can be revised
The system SHALL let the user reopen and change survey answers at any time, and changes SHALL create a new profile version.

#### Scenario: Revise salary floor
- **WHEN** an approved user changes their salary floor and saves
- **THEN** a new profile version is stored with the new floor and the change is written to the activity log
