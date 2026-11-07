# Architecture

Companion to [PRD.md](PRD.md) v1.1. Everything runs on one cloud droplet. The daily run is stateless: it queries, ranks, applies to the top N and stores only what it applied to.

## System diagram

Rendered copy for slides: [architecture.png](architecture.png). Regenerate with `npx -y @mermaid-js/mermaid-cli -i docs/ARCHITECTURE.md -o docs/architecture.png` after editing the Mermaid source below.

```mermaid
flowchart TB
    U[User]

    subgraph Sources["Inputs the agent reads"]
        direction LR
        RES[Resume upload]
        LI[LinkedIn public profile]
        GH[GitHub]
        DRIVE[Google Drive]
        ATSAPI[Ashby · Greenhouse · Lever<br/>public board APIs]
        HN[HN Who is hiring]
        LIJ[LinkedIn job search<br/>best effort]
        LEVELS[levels.fyi]
    end

    subgraph Droplet["Cloud droplet"]
        direction TB
        subgraph Front["Front door"]
            direction LR
            WEB[Web app<br/>kanban · profile review · run view<br/>panic search · feedback intake]
            API[API]
            SCHED[Scheduler<br/>daily run · hourly mail sync]
        end
        Q[(Task queue)]
        subgraph Pipeline["Daily run (stateless)"]
            direction LR
            DISC[Discovery] --> DEC[Decision + ranking<br/>top N, deadline tiebreak] --> TAIL[Resume tailoring<br/>PDF] --> APPLY[Apply worker<br/>Playwright]
            APPLY -. CAPTCHA .-> CAP[CAPTCHA chain<br/>agent 1 → agent 2 → human]
        end
        subgraph Inbox["Inbox loop"]
            direction LR
            MAIL[Mail sync + scheduling] --> NOTIF[Digest + reminders]
            MAIL --> PREP[Prep plan +<br/>negotiation data]
        end
        subgraph State["State"]
            direction LR
            DB[(Postgres<br/>users · profiles · companies · jobs<br/>applications · interviews · email_threads<br/>activity_log · captcha_requests)]
            VAULT[(Credential vault<br/>Google tokens · ATS passwords)]
            FILES[(File store<br/>resume PDFs · CAPTCHA images)]
        end
        LLM[LLM gateway<br/>versioned prompts]
    end

    subgraph Outside["Where the agent acts"]
        direction LR
        ATSFORM[ATS application forms<br/>account creation]
        GMAIL[User's Gmail + Calendar<br/>via Google OAuth]
        REC[Recruiter]
        SIM[Simulated recruiter<br/>demo tenants only]
    end

    RES & LI & GH & DRIVE --> API
    ATSAPI & HN & LIJ --> DISC
    LEVELS --> PREP

    U <--> WEB --> API
    API --> Q
    SCHED --> Q
    Q --> Pipeline
    Q --> Inbox

    Pipeline --> LLM
    Inbox --> LLM
    Pipeline --> State
    Inbox --> State
    API --> DB

    APPLY --> ATSFORM
    MAIL <--> GMAIL
    REC <--> GMAIL
    SIM -. demo replies .-> GMAIL
    CAP -. CAPTCHA image by email .-> U
    MAIL -. confirm interview slot .-> U
    NOTIF -. email .-> U
```

## Daily run

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant D as Discovery
    participant J as Decision + ranking
    participant DB as Postgres
    participant T as Tailoring
    participant A as Apply (Playwright)
    participant ATS as ATS form
    participant U as User

    S->>D: run for user
    D->>ATS: fetch current postings (board APIs, HN)
    D->>DB: drop postings that already have an application row
    D->>J: remaining postings
    J->>J: judge each (apply? + rationale), rank by fit, deadline as tiebreaker
    J-->>D: top N (default 12)
    loop each of the top N
        T->>DB: write job + application (PENDING)
        T->>A: tailored resume PDF + form answers
        A->>ATS: fill and submit
        alt CAPTCHA
            A->>A: agent 1, then agent 2
            A-->>U: email image + reply form (15 min hold)
        end
        A->>DB: status APPLIED, activity log
    end
    S-->>U: daily digest
```

## Scheduling an interview

```mermaid
sequenceDiagram
    participant R as Recruiter
    participant G as Gmail
    participant M as Mail sync
    participant C as Calendar
    participant U as User
    participant DB as Postgres

    R->>G: proposes times
    M->>G: hourly sync, link thread to application
    M->>C: read availability
    M-->>U: email with non-conflicting slots
    U->>M: confirms one slot
    M->>G: reply to recruiter
    M->>C: create event with prep plan link
    M->>DB: interview row, status INTERVIEWING
```

## Dashboard

The board is a read model over `applications`; there is no board table. Four columns map from the
status in `apps/api/src/services/board.ts` (`columnOf`):

| Status | Column | Badge |
| --- | --- | --- |
| `pending` | Applied | `pending` |
| `applied` | Applied | none |
| `interviewing` | Interviewing | none |
| `offer` | Offer | none |
| `closed` | Closed | none |

`GET /api/board` returns `{columns: {applied, interviewing, offer, closed}}`, each a list of cards
(company, title, location mode, posted pay range, date applied, last activity), newest activity
first. A pending application sits inside Applied with `badge: 'pending'` and moves out of the badge
state when the agent or the user changes its status. Cards without a posted range show the pay as
not listed.

A user move is `POST /api/applications/:id/stage` with `{from, to}`, where `from` is the status the
client saw. In one transaction it updates `applications.status` only while the row still has `from`,
inserts a `stage_overrides` row and writes a user-actor `stage_changed` activity entry. A mismatch
returns 409 with the current status and writes nothing; an unknown or other-tenant id is 404.
Moving to Closed sets `closed_reason = 'user'`. The agent never reopens a closed card: its own
status writes are conditional on the current status, and jobs that act on an application check
`isActionable` first.

`GET /api/applications/:id` is the card detail: job summary, the decision rationale from the
run's candidate (null once the run is purged), resume reference, form answers, unmet requirements,
linked email threads, sent messages, interviews with slot state (`open`, `confirmed`, `expired`,
`invalidated`), prep plan, feedback, offer data, a captcha summary and the activity log. Activity
is cursor-paged newest first (`activity_before` with the `activity_next` value). A request for
another tenant's application is 404.

`GET /api/search/companies?q=` is the panic search: a case-insensitive substring match on company
names of the signed-in user's applications, at most 20, minimum two characters (otherwise 400).
Selecting a result opens the card and highlights it on the board.

## Boundaries

- **Read-only sources:** LinkedIn public profile and job search, GitHub, HN, the three ATS board APIs, levels.fyi.
- **Writes on the user's behalf:** ATS application forms and ATS account creation, Gmail sends (scheduling and follow-ups only), Calendar events.
- **Never automated:** booking an interview without the user's confirmed slot, any message involving compensation, voluntary self-identification fields, LinkedIn or Indeed logged-in applying.
- **Tenant isolation:** every table carries `tenant_id`; vault keys are per tenant; the simulated recruiter is enabled by a tenant flag and never for real tenants.
