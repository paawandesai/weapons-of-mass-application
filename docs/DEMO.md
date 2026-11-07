# Demo

How to run the seeded demo tenant locally: a fictional user, twelve postings served as local
fixture forms, a simulated recruiter that answers applications, and a local mailbox and calendar
so the whole loop (application, proposal, slot offer, confirmation, booking, acknowledgement) runs
on one machine with no Google account.

Nothing here applies to a real tenant. The demo tenant is the only one with `tenants.demo = true`;
real tenants keep using Gmail and Google Calendar.

## Setup

1. Prerequisites: Node 22, pnpm, Docker.
2. Copy `.env.example` to `.env` and set at least:

   | Variable                      | Value                                                                             |
   | ----------------------------- | --------------------------------------------------------------------------------- |
   | `VAULT_MASTER_KEY`            | `openssl rand -base64 32`                                                         |
   | `SESSION_SECRET`              | any long random string                                                           |
   | `ANTHROPIC_API_KEY`           | needed by the inbox sync, which classifies the recruiter's mail                  |
   | `DEMO_LOGIN_TOKEN`            | any secret string; enables `POST /auth/demo` (never in production)               |
   | `DEMO_FORMS_PORT`             | `4310`; makes the worker serve the fixture forms and poll the simulated recruiter |
   | `SIMULATED_RECRUITER_DELAY_S` | optional; seconds before the recruiter answers (default 60)                       |

3. Start Postgres, migrate and seed:

   ```bash
   docker compose up -d postgres
   pnpm db:migrate
   pnpm seed:demo
   ```

4. Start the services: `pnpm dev` (api on :3000, worker, web on :5173).

`scripts/demo-rehearsal.sh` does steps 3 and 4 in one go, checks health, signs in once and prints
timings. See `--help` for flags (`--e2e` to run the Playwright suite, `--keep` to leave the
services running, `--no-seed`, `--api-port`, `--forms-port`, `--log-dir`). Logs go to
`./data/logs`.

## The seed

`pnpm seed:demo` connects as the database owner (`DATABASE_URL`), because only the owner can set
`tenants.demo`. It is idempotent: it matches on the tenant slug `demo`, the user
`demo@wma.local`, each company's board and each posting's URL, so running it again changes
nothing. It creates:

- the tenant `demo` with the demo flag, and one user, `demo@wma.local`, time zone
  America/Los_Angeles, with an approved fictional profile (staff/senior software engineer, Bay
  Area, remote OK) and connected sources;
- twelve fictional companies with one posting each, spread over the three form shapes
  (Greenhouse, Lever, Ashby), at `<forms origin>/forms/<vendor>/<posting>` (`DEMO_FORMS_ORIGIN`, else `http://127.0.0.1:$DEMO_FORMS_PORT`, default 4310); one posting
  ends in `?captcha` and shows a CAPTCHA challenge when submitted;
- one finished run dated yesterday, with its twelve candidates in rank order, so the run view is
  populated.

It creates no applications. The application database role cannot change the flag (a migration
removes its `UPDATE` right on `tenants`), and no API route writes it.

### Rehearsal fixtures

`pnpm seed:demo --scenarios` also provisions deterministic fixtures: an applied application whose
simulated proposal is already in the mailbox, an interviewing application with a booked interview
and a ready prep plan, an Offer application with pay data, and today's run left `running` with a
few candidates. A second pass changes no counts and puts those three cards back in their stage.
`scripts/demo-rehearsal.sh --e2e` seeds with it and the e2e setup fails if a fixture is missing.
Do not use it for the live demo: the running run occupies today's run date.

The demo tenant's daily run also searches its seeded postings, and the worker routes the fixture
forms (`<forms origin>/forms/<vendor>/...`) to the vendor's adapter, only when `DEMO_FORMS_PORT` or
`DEMO_FORMS_ORIGIN` is set.

### Demo inbox

For the demo tenant the web app shows an Inbox link (`/demo/inbox`, backed by
`GET /api/admin/demo-mailbox`, 404 for other tenants) listing the simulated mailbox with its links
clickable, so the slot-confirmation and CAPTCHA links can be opened on stage.

## Signing in

The demo user has no Google account. Sign in with the token from `.env`:

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/auth/demo -H "X-Demo-Token: $DEMO_LOGIN_TOKEN"
```

The response sets the session cookie. With `pnpm dev` the web app shares the origin through its
proxy, so the same request against `http://localhost:5173/auth/demo` signs the browser in. The
route answers 404 unless the server is not in production, the token is set and matches, and
exactly one tenant is flagged.

## The simulated recruiter

For the demo tenant and its seeded postings only, the worker plays the employer:

1. When an application on a seeded posting reaches `applied`, a message from a recruiter at that
   company arrives in the tenant's local mailbox: from `<first>.<last>@<company-slug>.example`, with
   the posting title in the subject, three interview slots on upcoming weekdays and the header
   `X-WMA-Simulated: 1`. It arrives after `SIMULATED_RECRUITER_DELAY_S` seconds (60 by default).
2. The real inbox sync reads it, links it to the application, classifies it and sends the user the
   slot-confirmation email (also in the local mailbox).
3. After the user confirms a slot, the real booking job replies on the thread, writes an event to
   the local calendar, moves the card to Interviewing and schedules the reminders.
4. The recruiter answers the reply in the same thread: an acknowledgement naming the slot, or, if
   the reply names a time that was not offered, a message saying so that repeats the three slots.

The worker checks every 30 seconds while `DEMO_FORMS_PORT` is set, so no hook in the submission
job is needed. Whenever it writes mail it also queues an inbox sync for the user.

## On-demand sync

The inbox sync normally runs hourly. In the demo, trigger it when you need it:

```bash
# one pass of the simulated recruiter without its delay, then an inbox sync
curl -b cookies.txt -X POST http://localhost:3000/api/admin/sync-now
# a discovery run for today
curl -b cookies.txt -X POST http://localhost:3000/api/runs
```

`/api/admin/sync-now` answers 202, and 404 for any tenant without the demo flag.

## Production swap

The demo mailbox and calendar stand in for what a real deployment does with Google:

- Real tenants never use them: the worker picks mail and calendar ports by `tenants.demo`
  (`apps/worker/src/demo/factory.ts`), so a tenant without the flag gets Gmail and Google Calendar
  exactly as before.
- To show the loop against real mail instead, run the recruiter side from a second, real Gmail
  account (the original design): disable the demo flag for the tenant, connect the tenant's own
  Google account, and send the proposal and acknowledgement from the second account with the
  `X-WMA-Simulated: 1` header. The inbox sync, booking and reminder code is the same code.
- Leave `DEMO_LOGIN_TOKEN` unset and `NODE_ENV=production` on any real deployment; both disable
  demo sign-in.

## Measured run (2026-11-07)

Real model, fresh database, plain seed, fixture forms: the run judged the 12 postings in 10 s, the
10 approved applications were applied 126 s after the run ended (CAPTCHA fixture included), the
simulated recruiter's proposals and the slot-offer emails arrived within three minutes, confirming a
slot booked the interview in 2 s, and the prep plan was ready 30 s later. The acceptance timings in
PRD section 13 are met with room to spare.
