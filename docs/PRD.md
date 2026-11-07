# Weapons of Mass Application — PRD (hackathon MVP)

Version 1.2 · 2026-11-06 · Owner: Andre Batista

## 1. Summary

An agent that runs a job search end to end. The user connects their accounts once, answers a short preferences survey, reviews the profile the agent built, and from then on the agent finds jobs, decides which are worth applying to, writes a tailored resume for each, submits the application, follows up, handles scheduling email, and books interviews only after the user confirms a day and time. The user sees everything on a kanban board and in a daily digest.

This document describes the hackathon MVP of a multi-tenant SaaS. It records decisions already made, the assumptions taken where no decision was made, and what is explicitly out of scope.

The testable requirements derived from this document live in `openspec/` as OpenSpec changes; see the README for the order in which they apply.

## 2. Goals and non-goals

### Goals

1. Demonstrate the full loop on stage: profile built → jobs found → application submitted with a tailored resume → recruiter reply handled → interview confirmed by the user → interview on the calendar.
2. Operate without per-application or per-message approval. The user is interrupted only for the profile review, interview time confirmation, and CAPTCHAs no agent could solve.
3. Volume of 10–15 applications per user per day, configurable.
4. Be multi-tenant from day one: several users, each with their own profile, connections, jobs and board.

### Non-goals (deferred, not rejected)

- Home-folder scanning and the CLI tool that would do it.
- The learning loop (weight updates from outcomes). Outcomes are logged so it can be added later.
- Pairwise job comparison.
- LinkedIn, Indeed or any site that requires a logged-in session to apply. LinkedIn is used for discovery only.
- SMS notifications. Email only.
- Compensation negotiation by the agent. Negotiation *support* (data) is in scope; the agent never writes anything involving money.
- Hard filters in the decision engine. Preferences live in the profile and the model's judgment.
- Voluntary self-identification fields (race, gender, veteran, disability). They are optional and are left blank.

## 3. Users

**Primary user:** a working professional in an active or passive search who wants volume and quality without spending evenings on applications. The first user is the founder: senior/staff software or AI engineering, Bay Area or remote, $300k+ total compensation target.

**Demo user:** a seeded account with a real-looking profile. See §12.

## 4. Decisions already made

| Area | Decision |
|---|---|
| Deployment | One cloud droplet runs everything. |
| Database | Postgres. Profiles and other documents are jsonb columns. |
| Sign-in | Google OAuth. The same consent grants Gmail read and send, Calendar read and write, and Drive read. One token set per user, stored in the vault. |
| Tenancy | Multi-tenant SaaS; MVP ships with that data model, not a single-user shortcut. |
| Autonomy | Full autopilot. Applications, follow-ups and scheduling replies go out without per-item review. |
| Apply surfaces | Ashby, Greenhouse and Lever hosted application forms only. |
| Discovery surfaces | Ashby, Greenhouse, Lever public boards and APIs; LinkedIn and HN "Who is hiring" for discovery of companies and postings. |
| Browser automation | Playwright. |
| CAPTCHA | Escalation chain: solving agent → second agent → human. See §7.6. |
| ATS accounts | The agent creates accounts where the ATS requires one, with credentials in a password store. |
| Unknown form questions | Answered by the LLM from the profile. Never invented experience. |
| Profile storage | One profile document per user (`profile.json` shape, stored in Postgres as jsonb). |
| Profile review | The user reviews and can edit the generated master profile once, after the survey, before the first application. |
| Email sending | Scheduling only. Nothing involving compensation, a dollar sign, or terms of an offer. |
| Decision engine | One LLM judgment per posting, informed by the profile and survey. No hard-coded filters. |
| Pay data | Posted salary ranges on the job, plus levels.fyi for comparables. |
| Interview booking | Only after the user confirms a specific day and time. |
| Board stages | Applied, Interviewing, Offer, Closed. There is no Found stage and no stored queue. |
| Daily run | Query, rank, apply to the top N, store only what was applied to. Postings the agent skipped are not stored. |
| Status | Status is a column on the application row, not an event log. A separate activity log records what the agent did. |
| Learning | Outcomes are logged; nothing is learned from them yet. |

## 5. Assumptions (defaults taken without a decision)

These are reversible. Each one changes a bounded part of the system.

| # | Assumption | What changes if wrong |
|---|---|---|
| A1 | The stage demo runs on seeded jobs and a **simulated recruiter mailbox** that replies and proposes interview times. No real applications are sent during the demo. | A live demo needs a real company list and accepts that no recruiter will reply in time; the loop would end at "Applied". |
| A2 | Company discovery: an LLM generates a candidate company list from the profile, each name is resolved against the Ashby, Greenhouse and Lever public APIs, and HN "Who is hiring" is parsed as a second source. LinkedIn discovery is best-effort via public job search pages. | A curated seed list is simpler and more predictable for the demo. |
| A3 | CAPTCHA human path: the agent emails the user the CAPTCHA image with a one-click reply form; the browser session waits up to 15 minutes. | A live browser view (noVNC-style) is more general but costs a day of work. |
| A4 | ATS accounts are created with the user's own Gmail address. Verification links and one-time codes are read through the existing Gmail connection. | A system-owned mailbox per user avoids cluttering the user's inbox but needs mail hosting. |
| A6 | Password store is an application-level encrypted vault in Postgres (per-tenant key, envelope encryption). | A user-owned 1Password integration is out of reach for a hackathon. |
| A13 | The Google OAuth app runs in testing mode for the hackathon: up to 100 listed test users, with an unverified-app warning on the consent screen. Gmail send and Calendar write are restricted scopes and need Google's verification before a public launch. | Verification takes weeks and is a post-hackathon task. |
| A7 | Calendly-style booking links from recruiters are forwarded to the user in the digest rather than clicked by the agent. | Automating booking links adds one more Playwright flow. |
| A8 | Recruiter emails that raise compensation are surfaced in the digest and left unanswered by the agent. | Drafting a reply for the user to send is a small addition. |
| A9 | Decision output is a yes/no with written reasons, no numeric threshold. Near-misses are not surfaced in the MVP. | A score lets the user tune volume; can be layered on later. |
| A10 | If fewer than the daily target of qualifying jobs are found, the agent reports a short day. It does not apply to weaker matches. | Alternative: widen the search. |
| A11 | Users can drag cards between stages. The agent respects user moves and does not act on a card the user moved to Closed. | Agent-only movement is simpler but makes mistakes permanent. |
| A12 | Tailored resumes are rendered to PDF from one house template. The user does not pick a layout. | Layout choice is an "ungrillable" question; prototype if needed. |

## 6. User journey

1. **Sign in** with Google. The consent screen covers Gmail and Calendar.
2. **Connect** optional sources: upload a resume (PDF or DOCX), paste a LinkedIn public profile URL, enter a GitHub username, connect Google Drive.
3. **Survey**: target roles, salary floor, locations and remote preference, work-life balance, family constraints, relocation, career direction, daily application target.
4. **Profile review**: the agent builds the master profile; the user edits and approves it. No application goes out before approval.
5. **Autopilot**: every run, the agent discovers postings, judges each one, tailors a resume, submits applications, and records them on the board.
6. **Daily digest** by email: jobs applied to, replies received, pending CAPTCHAs, threads that need the user, upcoming interviews.
7. **Scheduling**: when a recruiter proposes times, the agent checks the calendar and emails the user the candidate slots. The user confirms one. Only then does the agent reply to the recruiter and create the calendar event.
8. **Interview prep**: each booked interview gets a prep plan linked from its card.
9. **Feedback**: after an interview the user logs notes and any interviewer feedback on an intake form. Stored for later learning.
10. **Offer**: when an offer arrives, the card moves to Offer and the agent attaches comparables from the posted range and levels.fyi. The agent writes nothing to the employer about money.

## 7. Functional requirements

### 7.1 Onboarding and profile

- Google OAuth sign-in creates the tenant and user. Scopes: Gmail read and send, Calendar read and write.
- Resume parsing to structured history: roles, dates, titles, skills, education.
- LinkedIn public profile: fetch what is visible without login; degrade gracefully to headline and current role.
- GitHub by username: public repositories, languages, recent activity.
- Google Drive: the user picks folders; documents are scanned for portfolios, writing samples, certificates, past cover letters.
- The survey is a single page; answers are stored on the profile.
- The master profile is one jsonb document with sections: identity, contact, work history, projects, skills, education, preferences, survey answers, standard form answers (work authorization, visa, start date, earliest start date as an ISO date, notice period, reasons for change).
- The profile review screen renders the document as an editable form. Approval is a stored flag and timestamp; autopilot is gated on it.

### 7.2 Discovery

- Sources: Ashby, Greenhouse and Lever public board APIs; HN "Who is hiring" monthly thread; LinkedIn public job search as best-effort.
- Company list per user: generated from the profile by the LLM, resolved to ATS board slugs, cached, and grown over time. Users can add or remove companies.
- Discovery is stateless. Each run fetches current postings, drops any that already have an application row for this user (matched by ATS job id or normalized URL), and hands the rest to the decision step. Postings that are skipped are not stored and may be judged again on a later run.
- A JOB row is written only when the agent starts an application for it.

### 7.3 Decision

- Input: the posting (title, description, location, posted pay range), the profile, the survey.
- Output per posting: `apply: true|false`, a short rationale, and the key facts extracted from the posting (pay range, location mode, seniority, application deadline if stated).
- One LLM call per posting. Deterministic prompt, versioned so decisions are comparable across prompt changes.
- Ranking: approved postings are ordered by the model with fit first and stated deadlines as a tiebreaker, so a posting closing today is not lost to tomorrow's run. The prompt carries the deadline rule; there is no separate scheduler.
- Daily target: the agent applies to the top N of that ranked list, where N is the user's configured target (default 12, range 1–30). The rest are discarded, not queued.

### 7.4 Resume tailoring

- One resume per application, generated from the master profile and the posting.
- Rules: reorder and reframe real experience; match the posting's vocabulary and stack; never add employers, titles, dates, degrees, or skills not in the profile.
- Rendered to PDF from the house template; stored with the application.

### 7.5 Application submission

- Playwright worker opens the ATS application page and fills the form from the profile and tailored resume.
- Standard fields are mapped. Free-text questions are answered by the LLM from the profile, capped in length, and stored with the application so the user can see what was said.
- Voluntary self-identification sections are skipped.
- If the ATS requires an account, the agent creates one with the user's Gmail address and a generated password, stores the credential in the vault, and reads the verification email through Gmail.
- Submission is confirmed by the ATS confirmation page or email; status moves to APPLIED with the timestamp.
- A submission that fails or is parked on a CAPTCHA is stored as PENDING with the error in the activity log, so it is retried once on the next run and is not re-judged. PENDING is the only in-flight state; it is shown inside the Applied column with a badge, not as its own lane.

### 7.6 CAPTCHA escalation chain

1. **Solver agent**: screenshot of the challenge, vision model attempt, up to 3 tries.
2. **Second agent**: a separate model or prompt attempts the same challenge, up to 3 tries.
3. **Human**: the user receives an email with the challenge image and a reply form. The browser session is held for up to 15 minutes. If no answer arrives, the application is parked and retried the next day.

Every escalation is recorded in the activity log with which stage resolved it.

### 7.7 Email and scheduling

- The agent reads the user's Gmail for application confirmations, rejections, interview invitations and offers, and links each thread to an application by company and job title.
- The agent sends follow-ups to recruiters and hiring managers on a schedule (default: 7 days after applying, once).
- When an email proposes interview times, the agent reads the calendar, picks slots that do not conflict, and emails the user the options. The user confirms a day and time with one click. The agent then replies to the recruiter and creates the calendar event with company, role, interviewer and a link to the prep plan.
- A booking link in the email is forwarded to the user; the agent does not book it.
- The agent never writes an email that mentions compensation, salary, equity, a dollar amount, or offer terms. Such threads are surfaced to the user in the digest.
- Every outgoing message is stored with the application.

### 7.8 Notifications

- Daily digest email, one per user per day, at a user-set hour.
- Immediate emails for: interview time confirmation requests, CAPTCHA requests.
- Reminders 24 hours and 1 hour before each confirmed interview.

### 7.9 Dashboard

- Kanban board with columns Applied, Interviewing, Offer, Closed. Pending submissions appear in Applied with a badge. Each card shows company, title, location mode, posted pay range, date applied, and last activity.
- Card detail shows the tailored resume, the answers given on the form, the email thread, the activity log, and the prep plan when one exists.
- The user can drag cards between columns. A card in Closed receives no further agent action.
- Interview feedback intake form linked from each Interviewing card.

### 7.10 Interview prep plan

- Generated when an interview is booked: likely questions, topics to review, company research, interviewer background if public.
- One page, linked from the card and from the reminder email.

### 7.11 Negotiation support

- When an application reaches Offer, attach the posted range, levels.fyi comparables for the title and location, and the user's salary floor from the survey.
- Read-only. No message to the employer is produced.

### 7.12 Logging for future learning

- Every application records: decision rationale, tailored resume, form answers, outcome (response, rejection, silence, interview, offer) and dates.
- Interview feedback and user overrides (manual card moves, company removals) are stored against the application.

## 8. Data model

All tables carry `tenant_id`. Status is a column, not an event stream.

- **users**: id, tenant_id, email, google tokens (encrypted), digest hour, daily target.
- **profiles**: user_id, document (jsonb), approved_at, version.
- **companies**: id, name, ats (ashby | greenhouse | lever), board_slug, source, created_by (llm | user | hn).
- **jobs** (written only when an application starts): id, company_id, ats_job_id, title, url, description, location, location_mode (onsite | hybrid | remote), pay_min, pay_max, posted_at, raw (jsonb). Unique on (ats, ats_job_id).
- **applications**: id, user_id, job_id, status (pending | applied | interviewing | offer | closed), decision (jsonb: apply, rationale), resume_pdf_ref, form_answers (jsonb), applied_at, closed_reason, last_activity_at.
- **ats_credentials**: user_id, ats, company_id, username, password_ciphertext, created_at.
- **email_threads**: application_id, gmail_thread_id, kind (confirmation | rejection | interview | offer | other), last_message_at.
- **interviews**: application_id, proposed_slots (jsonb), confirmed_at, starts_at, ends_at, calendar_event_id, prep_plan (text), feedback (jsonb).
- **activity_log**: application_id, at, actor (agent | user), action, detail (jsonb). The audit trail for everything the agent did.
- **captcha_requests**: application_id, stage (agent1 | agent2 | human), image_ref, resolved_at, resolution.

## 9. Architecture

- **Droplet** running: a web app (board, profile review, intake forms), an API, Postgres, a task queue for the workers (not an application queue), and Playwright workers.
- **Scheduler** triggers a discovery and application run per user daily and a mail-sync run hourly.
- **LLM** calls for profile building, company list generation, decision, tailoring, form answers, CAPTCHA attempts, scheduling email parsing, prep plans. Each call type has a versioned prompt.
- **Secrets**: Google tokens and ATS passwords encrypted at rest with a per-tenant key.
- **Simulated recruiter** (demo only): a mailbox that replies to applications sent to seeded jobs with an interview-time proposal and accepts the agent's confirmation. Toggled by a tenant flag and never active for real tenants.

## 10. Guardrails

- No interview is booked without the user's explicit confirmation of day and time.
- No application goes out before the user approves the master profile.
- Tailoring never invents experience. The tailored resume and every form answer are visible on the card.
- The agent sends nothing involving compensation or offer terms.
- Voluntary self-identification is never filled in.
- Sources read only what the user connected; any source can be disconnected, which stops further reads.
- The activity log records every action the agent takes on the user's behalf.

## 11. Out of scope for MVP

Home-folder scan and CLI, learning loop, pairwise comparison, logged-in LinkedIn or Indeed applying, SMS, automated booking of Calendly-style links, numeric scoring and thresholds, near-miss surfacing, multiple resume templates, negotiation messages.

## 12. Demo plan

1. Sign in as the demo user; show connected sources and the approved profile.
2. Trigger a run. The run view lists the day's ranked candidates with rationales as they are processed; cards appear in Applied with the tailored resume attached. The run view is ephemeral and is not a stored queue.
3. Show one application that hit a CAPTCHA and the chain that resolved it.
4. The simulated recruiter replies with times. The user's inbox shows the confirmation email; click one slot.
5. The card moves to Interviewing; the calendar event and prep plan appear.
6. Show the digest email and the activity log for one card.

## 13. Acceptance criteria

- A new user can sign in, upload a resume, complete the survey, and approve a profile in under 10 minutes.
- A run against seeded boards shows at least 10 ranked candidates with rationales in the run view and produces at least 5 Applied cards with PDFs and recorded form answers.
- A second run on the same day produces no duplicate applications.
- A seeded CAPTCHA is resolved by stage 1 or 2 at least once in the demo, and the human path works when both fail.
- A recruiter reply with proposed times results in a confirmation email to the user, and confirming a slot creates a calendar event and a reply to the recruiter, with nothing sent before the click.
- No outgoing email in the demo contains a dollar sign or the words salary, compensation or equity.
- Two tenants cannot see each other's jobs, applications or credentials.

## 14. Open questions

None blocking. Each assumption in §5 can be revisited; A1 (demo mode) and A2 (discovery source) are the two most worth confirming before implementation starts.
