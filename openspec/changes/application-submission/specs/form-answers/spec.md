# Spec Delta

## Purpose

Generates answers to the free-text and non-standard questions on an application form from the user's profile, so forms can be completed without the user, and records every answer so the user can see what was said in their name.

## ADDED Requirements

### Requirement: Standard fields come from the profile
The system SHALL fill standard application fields (name, email, phone, location, links, work authorization, visa status, start date, notice period, reasons for change) directly from the master profile's identity, contact and standard-answer sections without an LLM call.

#### Scenario: Standard field present in profile
- **WHEN** the form has a "Work authorization" field and the profile's standard answers include work authorization
- **THEN** the field is filled with the profile value verbatim

#### Scenario: Standard field missing from profile
- **WHEN** the form has a required standard field and the profile has no value for it
- **THEN** the form is not submitted, the application is marked PENDING with reason "missing-profile-field" naming the field, and the activity log records it

### Requirement: Free-text questions are answered from the profile
For any question that is not a standard field, the system SHALL generate an answer grounded only in the master profile and the posting, written in first person, and SHALL not assert facts absent from the profile.

#### Scenario: "Why do you want to work here?"
- **WHEN** the form asks an open question about motivation
- **THEN** the answer references the company or role from the posting and the user's relevant experience from the profile, and contains no employer, project or credential that is not in the profile

#### Scenario: Question cannot be answered from the profile
- **WHEN** the question asks for a fact the profile does not contain (for example a specific certification number)
- **THEN** the field is left blank if optional; if required, the application is marked PENDING with reason "unanswerable-question" and the question text is recorded

### Requirement: Answers respect length limits
Each generated answer SHALL fit within the field's declared maximum length when one exists, and otherwise SHALL be at most 1,200 characters.

#### Scenario: Field declares a 500 character limit
- **WHEN** the form field has a maximum of 500 characters
- **THEN** the generated answer is 500 characters or fewer

### Requirement: Voluntary self-identification is never filled
The system SHALL leave every voluntary self-identification field (race, ethnicity, gender, veteran status, disability status) blank or at its "decline to answer" option, regardless of whether a value could be inferred.

#### Scenario: EEO section present
- **WHEN** the form contains a voluntary self-identification section
- **THEN** no option in that section is selected except an explicit "I don't wish to answer" choice when the section is required to have a selection

### Requirement: Every answer is stored with the application
The system SHALL store every field value and generated answer submitted on the form, keyed by the question text, on the application record.

#### Scenario: User reviews submitted answers
- **WHEN** the user opens an application that has been submitted
- **THEN** every question on the form is listed with the exact value that was entered
