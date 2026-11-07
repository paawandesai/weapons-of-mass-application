# Spec Delta

## Purpose

Produces one truthful, posting-specific resume PDF per application from the user's approved master profile, so every submission presents real experience in the vocabulary of the job it targets.

## ADDED Requirements

### Requirement: One tailored resume per application
The system SHALL generate a distinct resume for each application, derived from the user's approved master profile and the target posting, and SHALL store it with that application.

#### Scenario: Two applications from one profile
- **WHEN** the daily run hands over two different postings for the same user
- **THEN** two resumes are generated, each stored on its own application, and the two resumes differ in ordering or emphasis according to each posting

#### Scenario: Profile not approved
- **WHEN** a tailoring request arrives for a user whose master profile has no approval timestamp
- **THEN** no resume is generated, the application is not created, and the refusal is written to the activity log

### Requirement: Tailoring never invents experience
The tailored resume SHALL contain only employers, titles, dates, degrees, certifications and skills present in the master profile. Reordering, reframing and matching the posting's vocabulary are allowed; adding facts is not.

#### Scenario: Posting asks for a skill the profile lacks
- **WHEN** the posting requires a skill that does not appear anywhere in the master profile
- **THEN** the generated resume does not list that skill, and the omission is recorded on the application as an unmet requirement

#### Scenario: Automated truthfulness check fails
- **WHEN** a post-generation check finds an employer, title, date range or degree in the resume that is not in the profile
- **THEN** the resume is discarded, generation is retried once, and if the second attempt also fails the application is marked PENDING with reason "tailoring-check-failed"

### Requirement: Resume matches the posting's vocabulary
The tailored resume SHALL use the posting's own terms for stack, role and seniority where the profile contains equivalent experience, and SHALL order sections and bullets so the most relevant experience appears first.

#### Scenario: Equivalent terminology
- **WHEN** the posting says "Kubernetes" and the profile says "k8s"
- **THEN** the resume uses "Kubernetes"

### Requirement: Rendered as a PDF from the house template
Every tailored resume SHALL be rendered to a PDF using the single house template, with the file stored in the file store and its reference saved on the application.

#### Scenario: Successful render
- **WHEN** tailoring completes
- **THEN** a PDF of at most two pages exists in the file store, the application's resume reference points to it, and the PDF opens with the user's name on the first line

#### Scenario: Render fails
- **WHEN** PDF rendering throws or produces an empty file
- **THEN** the application is marked PENDING with reason "render-failed", the error is written to the activity log, and the submission step does not start

### Requirement: Tailoring is visible to the user
The tailored resume and the list of unmet requirements SHALL be retrievable for the application so the user can see exactly what was sent.

#### Scenario: User opens an application
- **WHEN** the user requests the application's detail
- **THEN** the response includes a link to the resume PDF and the unmet requirements recorded at tailoring time
