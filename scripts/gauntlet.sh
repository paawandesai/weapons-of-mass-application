#!/usr/bin/env bash
# Gauntlet Jobs: a fresh local database seeded with one fictional AI Engineer posting, and a
# simulated recruiter that runs one scripted scenario for it (confirmation, interview requests,
# scheduling, reschedules, rejection or offer). Everything stays in the app's fake mailbox and
# calendar; nothing reaches Gmail or Google Calendar.
#
#   scripts/gauntlet.sh [scenario]   start one scenario (default: slots)
#   scripts/gauntlet.sh golden       start all eight golden employers, each under its own scenario
#   scripts/gauntlet.sh --golden     the regression gate: start golden, run the loop, play the user,
#                                    wait for the recruiter scripts to settle, score, stop. Exit 1 on
#                                    any failure. Needs ANTHROPIC_API_KEY. About five minutes.
#   scripts/gauntlet.sh --list       list the scenarios
#   scripts/gauntlet.sh --stop       stop the api, worker and web started by a previous run
#
# Each start resets the wma_gauntlet database, so every run begins from nothing.
# Set DEMO_PROFILE_PATH to a profile JSON to apply as yourself instead of the demo persona.
# GAUNTLET_TIME_SCALE (default 10080 = 7 days -> 1 minute) compresses the seven-day follow-up so
# the ghost scenario completes in a session; set it to 1 for real time.
set -euo pipefail
cd "$(dirname "$0")/.."

SCENARIOS="golden slots availability booking-link vague-time pay-question injection reschedule rounds rejection offer ghost"
API_PORT="${PORT:-3000}"
FORMS_PORT="${DEMO_FORMS_PORT:-4310}"
WEB_PORT="${WEB_PORT:-5173}"
DB="wma_gauntlet"

stop() {
  for port in "$API_PORT" "$FORMS_PORT" "$WEB_PORT"; do
    pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "$pids" ]]; then kill $pids && echo "stopped what was listening on port $port"; fi
  done
}

GATE=0
case "${1:-slots}" in
  --list) echo "$SCENARIOS" | tr ' ' '\n'; exit 0 ;;
  --stop) stop; exit 0 ;;
  --golden) GATE=1; set -- golden ;;
  -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
scenario="${1:-slots}"
if [[ " $SCENARIOS " != *" $scenario "* ]]; then
  echo "unknown scenario '$scenario'; one of: $SCENARIOS" >&2
  exit 2
fi
# A running api or worker keeps the scenario it was started with, and the rehearsal would reuse it.
for port in "$API_PORT" "$FORMS_PORT" "$WEB_PORT"; do
  if lsof -ti "tcp:$port" -sTCP:LISTEN > /dev/null 2>&1; then
    echo "port $port is in use (a previous run?). Stop it first: scripts/gauntlet.sh --stop" >&2
    exit 1
  fi
done

if [[ -f .env ]]; then set -a; . ./.env; set +a; fi
mkdir -p data/logs

# 1. Postgres, then a fresh database for this scenario.
if [[ "$(docker inspect -f '{{.State.Running}}' wma-postgres 2>/dev/null || echo false)" != "true" ]]; then
  docker compose up -d postgres < /dev/null
fi
until docker exec wma-postgres pg_isready -U wma -d wma > /dev/null 2>&1; do sleep 1; done
scripts/db-test-reset.sh --db "$DB"

# 2. Seed and start the api and worker (the rehearsal script), then the web app.
export DATABASE_URL="postgres://wma:wma@localhost:5432/$DB"
export GAUNTLET_SCENARIO="$scenario"
export DEMO_LOGIN_TOKEN="${DEMO_LOGIN_TOKEN:-gauntlet-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}"
export SIMULATED_RECRUITER_DELAY_S="${SIMULATED_RECRUITER_DELAY_S:-10}"
export GAUNTLET_TIME_SCALE="${GAUNTLET_TIME_SCALE:-10080}"
# The gate needs a short recruiter delay so the scripted chains finish in minutes.
if [[ "$GATE" == 1 ]]; then export SIMULATED_RECRUITER_DELAY_S="${GATE_RECRUITER_DELAY_S:-10}"; fi
scripts/demo-rehearsal.sh --keep --no-docker --api-port "$API_PORT" --forms-port "$FORMS_PORT"

if [[ "$GATE" == 1 ]]; then
  api="http://127.0.0.1:$API_PORT"
  export WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:$WEB_PORT}"
  jar=$(mktemp)
  # psql from the host when installed, else the one inside the Postgres container.
  if command -v psql > /dev/null 2>&1; then
    q() { psql "$DATABASE_URL" -tAc "$1"; }
  else
    q() { docker exec wma-postgres psql -U wma -d "$DB" -tAc "$1"; }
  fi
  trap 'rm -f "$jar"; stop' EXIT

  echo "gate: signing in as the demo user and starting the run"
  curl -fs -c "$jar" -X POST -H "x-demo-token: $DEMO_LOGIN_TOKEN" "$api/auth/demo" > /dev/null
  curl -fs -b "$jar" -X POST -H "Origin: $WEB_ORIGIN" "$api/api/runs" > /dev/null

  echo "gate: playing the user (autopilot) while the loop and the recruiter scripts run"
  API_ORIGIN="$api" pnpm --silent gauntlet:autopilot --watch > data/logs/autopilot.log 2>&1 &
  AUTOPILOT=$!

  # Done when the run has ended and nothing has changed for QUIET_S: no new mail, no new interview
  # confirmations, no new follow-ups. Hard cap MAX_S.
  QUIET_S="${GATE_QUIET_S:-90}"; MAX_S="${GATE_MAX_S:-900}"
  start=$(date +%s); last_change=$start; last_sig=""
  while :; do
    now=$(date +%s)
    run_done=$(q "select count(*) from runs where status <> 'running'")
    sig=$(q "select (select count(*) from demo_mailbox_messages) || ':' ||
                    (select count(*) from interviews where confirmed_at is not null) || ':' ||
                    (select count(*) from applications where followed_up_at is not null)")
    if [[ "$sig" != "$last_sig" ]]; then last_sig="$sig"; last_change=$now; fi
    if [[ "$run_done" -ge 1 && $((now - last_change)) -ge "$QUIET_S" ]]; then break; fi
    if [[ $((now - start)) -ge "$MAX_S" ]]; then echo "gate: hit the ${MAX_S}s cap; scoring what there is"; break; fi
    sleep 5
  done
  kill "$AUTOPILOT" 2>/dev/null || true

  echo; echo "gate: scorecard"; echo
  if pnpm --silent gauntlet:score; then
    echo; echo "GOLDEN RUN PASSED  (logs in data/logs; mailbox: DATABASE_URL=$DATABASE_URL pnpm gauntlet:mail)"
    exit 0
  else
    echo; echo "GOLDEN RUN FAILED  (logs in data/logs; mailbox: DATABASE_URL=$DATABASE_URL pnpm gauntlet:mail)"
    exit 1
  fi
fi

API_ORIGIN="http://127.0.0.1:$API_PORT" WEB_PORT="$WEB_PORT" \
  setsid pnpm -F @wma/web dev > data/logs/web.log 2>&1 < /dev/null &
until curl -fs -o /dev/null "http://localhost:$WEB_PORT" 2>/dev/null; do sleep 1; done

cat <<DONE

Gauntlet is running, scenario: $scenario

1. Open http://localhost:$WEB_PORT and sign in as the demo user: in the browser console run
     await fetch('/auth/demo', {method: 'POST', headers: {'x-demo-token': '$DEMO_LOGIN_TOKEN'}}); location.reload()
2. Start a run from the dashboard. The agent should apply to every seeded Gauntlet posting.
3. Watch the fake mailbox (recruiter mail, the agent's messages to you, its replies):
     DATABASE_URL=$DATABASE_URL pnpm gauntlet:mail
   To accept interview times yourself, open the confirm links in the agent's messages to you.
   To let the automated user accept them (what a golden run does):
     DATABASE_URL=$DATABASE_URL API_ORIGIN=http://127.0.0.1:$API_PORT pnpm gauntlet:autopilot --watch
4. Logs are in data/logs. Stop everything with: scripts/gauntlet.sh --stop
DONE
