# Proposal

## Why

The agent applies, schedules and logs on the user's behalf, but without a board, a run view and a demo-side recruiter none of that is visible or demonstrable. This change gives the user the live view of every opportunity by stage and gives the hackathon demo an employer that replies within minutes instead of weeks.

## What Changes

- Kanban dashboard with columns Applied, Interviewing, Offer, Closed; PENDING submissions shown as a badge inside Applied (PRD 7.9, A11).
- Card detail: tailored resume, form answers given, email thread, activity log, prep plan.
- User can drag cards between columns; the agent respects user moves and never acts on a Closed card. Manual moves are recorded as overrides (PRD 7.12).
- Panic search: a search bar over the companies in the user's applications that jumps to the card.
- Run view: an ephemeral list of the day's ranked candidates with their rationales as the daily run processes them; it reads run records and is not a stored queue (PRD 7.3, 12).
- Interview feedback intake: a form per interview for the candidate's own notes and any interviewer feedback they relay, stored against the application (PRD 7.9, 7.12).
- Interview prep plan generated when an interview is booked, linked from the card and from reminders (PRD 7.10).
- Negotiation support: when a card reaches Offer, attach the posted range, levels.fyi comparables and the user's salary floor; read-only, no message produced (PRD 7.11).
- Simulated recruiter: a demo-only mailbox, enabled by a tenant flag, that replies to applications on seeded jobs with proposed interview times and accepts the agent's confirmation; never active for real tenants (PRD 9, 12, A1). Seeded demo data for the stage demo.
- Tenant isolation on every dashboard read (PRD 13).

Out of scope for this change:
- Interviewer-facing feedback links and voice recordings. This is an open product question and is not specified here.
- Everything specified by the other four changes: sign-in, tenancy and profiles (`mvp-foundation`); discovery, decision and the daily run itself (`job-discovery-and-decision`); tailoring, submission and CAPTCHA (`application-submission`); inbox sync, scheduling and notifications (`inbox-and-scheduling`). This change reads their data and references their capabilities by name.
- Learning from feedback or overrides. They are stored only.
- SMS, numeric scoring, multiple resume templates.

## Capabilities

### New Capabilities
- `kanban-dashboard`: the board of applications by stage, card contents, card detail and user-driven stage changes.
- `panic-search`: finding an application by company name and jumping to its card.
- `run-view`: the live, ephemeral view of the current or most recent daily run for the user.
- `interview-feedback`: capturing the candidate's post-interview notes and relayed interviewer feedback against the application.
- `interview-prep`: generating and exposing a per-interview preparation plan.
- `negotiation-support`: attaching compensation comparables to an application that reaches Offer.
- `simulated-recruiter`: the demo-only employer side that answers applications and scheduling mail for flagged tenants, plus seeded demo data.

### Modified Capabilities
- None. This change adds behavior on top of `tenancy`, `profile`, `activity-log`, `daily-run`, `application-submission`, `inbox-sync`, `interview-scheduling` and `notifications` without changing their requirements.

## Impact

- apps/web: new board, card detail, panic search, run view, feedback form, prep plan page, offer panel.
- apps/api: dashboard read endpoints, stage-change endpoint, feedback and search endpoints, all tenant-scoped.
- apps/worker: prep plan generation on booking, negotiation data fetch on Offer, simulated recruiter job.
- packages/db: columns for user-moved stage overrides, feedback records, prep plans, negotiation data, tenant demo flag, seed script.
- packages/llm: prompts for prep plan and comparable extraction.
- External: levels.fyi (read-only, best effort), Gmail (simulated recruiter writes mail into the demo user's mailbox via the existing Google connection).
