# Spec Delta

## Purpose

Gives the user a one-page study guide for every booked interview, built from the posting, the profile and public information about the company and interviewer.

## ADDED Requirements

### Requirement: Prep plan generated on booking
When an interview is confirmed and booked, the system SHALL generate a prep plan for it containing likely questions, topics to review, company research and, when publicly available, interviewer background. Generation SHALL complete before the first reminder for that interview is sent.

#### Scenario: Plan generated after confirmation
- **WHEN** an interview is booked for an application
- **THEN** a prep plan exists for that interview within fifteen minutes containing the four sections

#### Scenario: Interviewer unknown
- **WHEN** the interview invitation names no interviewer or the name yields no public information
- **THEN** the plan omits the interviewer section and states that no interviewer information was found

#### Scenario: Generation fails
- **WHEN** plan generation fails
- **THEN** the failure is written to the activity log, generation is retried once, and the card shows that the plan is pending

### Requirement: Prep plan is reachable from card and reminder
The prep plan SHALL be linked from the interview on its card and from every reminder email for that interview.

#### Scenario: Link on card
- **WHEN** the user opens a card with a booked interview that has a plan
- **THEN** the card shows a link that opens the plan

#### Scenario: Link in reminder
- **WHEN** a reminder email for the interview is sent
- **THEN** it contains a link that opens the plan for that interview

### Requirement: Prep plan uses only the profile and public sources
The plan SHALL be built from the posting, the user's profile and publicly available company and interviewer information. It SHALL NOT state experience the user does not have.

#### Scenario: Questions tied to real experience
- **WHEN** a plan suggests how to answer a likely question
- **THEN** every example answer refers only to roles, projects and skills present in the user's profile
