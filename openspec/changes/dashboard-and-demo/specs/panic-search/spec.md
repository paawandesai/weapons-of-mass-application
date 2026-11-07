# Spec Delta

## Purpose

Lets a user who just got a call or email find the matching application by company name in seconds and land on its card.

## ADDED Requirements

### Requirement: Search applications by company
The dashboard SHALL provide a search field that matches the company name of the user's applications, case-insensitively and on partial text, and lists matching cards with company, title and current stage.

#### Scenario: Partial match
- **WHEN** the user types "acm" and has an application at Acme Robotics
- **THEN** the results list the Acme Robotics card with its title and stage

#### Scenario: No match
- **WHEN** the user types a name that matches none of their applications
- **THEN** the results state that nothing matched and the board stays visible

### Requirement: Jump to card
Selecting a search result SHALL open that application's card detail and highlight the card in its column.

#### Scenario: Select result
- **WHEN** the user selects a result from the search list
- **THEN** the card detail opens for that application and the board scrolls to and highlights its card

### Requirement: Search is tenant-scoped
Search SHALL only match applications belonging to the signed-in user's tenant.

#### Scenario: Other tenant's company
- **WHEN** another tenant has an application at Globex and the signed-in user does not
- **THEN** searching "Globex" returns no results
