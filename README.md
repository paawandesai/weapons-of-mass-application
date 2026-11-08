# Weapons of Mass Application

An agent that runs a job search end to end: builds a profile from your connected accounts, finds postings, decides which are worth applying to, writes a tailored resume for each, submits the application, handles recruiter email, and books interviews only after you confirm a time.

Hackathon MVP of a multi-tenant SaaS.

## Documents

| File | What it is |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements: decisions, assumptions, requirements per module, data model, demo plan, acceptance criteria. The behavioral source of truth. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagram, daily-run and scheduling sequences, boundaries. |
| [docs/llm-cost.md](docs/llm-cost.md) | LLM cost ledger: what each model call records, the purposes, how jobs are wired, how to read it. |
| [openspec/](openspec/) | [OpenSpec](https://openspec.dev) specs and changes. Each change has a proposal, delta specs in SHALL / WHEN / THEN form, a design and a task list. |

## Using a subscription instead of API tokens

Set `LLM_BACKEND` in `.env` and the worker drives a logged-in CLI instead of the API:

| `LLM_BACKEND` | Uses | One-time setup |
|---|---|---|
| `anthropic` (default) | Anthropic API, per token | `ANTHROPIC_API_KEY` |
| `claude-code` | Claude subscription via `claude -p` | `claude login` |
| `codex` | ChatGPT subscription via `codex exec` | `codex login` |
| `gemini` | Google account via `gemini -p` | run `gemini` once |
| `grok` | xAI API, **per token** (not a subscription) | `XAI_API_KEY` |

Run the worker on your own machine (not in the container). Keep `JUDGE_CAP_PER_RUN` low, since subscriptions have usage caps, and leave `LLM_CLI_CONCURRENCY` at 2 or less. Personal use only: it is your own login on your own machine. Implementation: `packages/llm/src/cli.ts`.

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
