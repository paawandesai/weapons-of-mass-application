# Weapons of Mass Application

An agent that runs a job search end to end: builds a profile from your connected accounts, finds postings, decides which are worth applying to, writes a tailored resume for each, submits the application, handles recruiter email, and books interviews only after you confirm a time.

Hackathon MVP of a multi-tenant SaaS.

## Documents

| File | What it is |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements: decisions, assumptions, requirements per module, data model, demo plan, acceptance criteria. The behavioral source of truth. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagram, daily-run and scheduling sequences, boundaries. |
| [openspec/](openspec/) | [OpenSpec](https://openspec.dev) specs and changes. Each change has a proposal, delta specs in SHALL / WHEN / THEN form, a design and a task list. |

## OpenSpec

Install the CLI once:

```bash
npm install -g @fission-ai/openspec@latest
```

Then, from the repo root:

```bash
openspec list
```

```bash
openspec validate --all --strict
```

Changes are meant to be applied in this order, since each builds on the capabilities of the one before:

1. `mvp-foundation`: tenancy, Google sign-in, profile, survey, review gate, activity log, credential vault
2. `job-discovery-and-decision`: company and job discovery, apply decision, stateless daily run
3. `application-submission`: resume tailoring, form answers, ATS submission, ATS accounts, CAPTCHA chain
4. `inbox-and-scheduling`: Gmail sync, follow-ups, interview scheduling, notifications
5. `dashboard-and-demo`: kanban, panic search, run view, feedback, prep plan, negotiation support, simulated recruiter

In Claude Code, `/opsx:apply` works through a change's tasks and `/opsx:archive` merges its deltas into `openspec/specs/`.
