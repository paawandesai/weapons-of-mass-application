# Spec Delta

## Purpose

Arms the user with compensation data when an offer arrives, without ever speaking to the employer about money on their behalf.

## ADDED Requirements

### Requirement: Comparables attached at Offer
When an application reaches status Offer, the system SHALL attach to it the posted pay range from the job, comparable compensation for the title and location from levels.fyi, and the user's salary floor from the survey.

#### Scenario: Card reaches Offer
- **WHEN** an application's status becomes offer
- **THEN** within one hour the card's offer panel shows the posted range, the comparables with their source and retrieval date, and the user's salary floor

#### Scenario: Comparables unavailable
- **WHEN** levels.fyi returns no data for the title and location
- **THEN** the offer panel shows the posted range and salary floor, states that no comparables were found, and the activity log records the lookup failure

### Requirement: Negotiation support is read-only
The system SHALL NOT send, draft or queue any message to the employer about compensation, terms or the offer. The offer panel is for the user only.

#### Scenario: No outbound message on Offer
- **WHEN** an application reaches offer and comparables are attached
- **THEN** no email is sent or drafted for that application by the agent

### Requirement: Offer data visible on card detail
The offer panel SHALL be part of the card detail for any application in Offer or Closed-after-Offer, and SHALL be tenant-scoped.

#### Scenario: Offer panel on detail
- **WHEN** the user opens a card in Offer
- **THEN** the detail shows the offer panel with the attached data

#### Scenario: Not visible across tenants
- **WHEN** a user requests the offer panel for an application in another tenant
- **THEN** the response is not found
