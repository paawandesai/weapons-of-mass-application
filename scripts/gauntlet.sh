#!/usr/bin/env bash
# Gauntlet Jobs: a fresh local database seeded with one fictional AI Engineer posting, and a
# simulated recruiter that runs one scripted scenario for it (confirmation, interview requests,
# scheduling, reschedules, rejection or offer). Everything stays in the app's fake mailbox and
# calendar; nothing reaches Gmail or Google Calendar.
#
#   scripts/gauntlet.sh [scenario]   start (default scenario: slots)
#   scripts/gauntlet.sh --list       list the scenarios
#   scripts/gauntlet.sh --stop       stop the api, worker and web started by a previous run
#
# Each start resets the wma_gauntlet database, so every scenario begins from nothing.
# Set DEMO_PROFILE_PATH to a profile JSON to apply as yourself instead of the demo persona.
set -euo pipefail
cd "$(dirname "$0")/.."

SCENARIOS="slots availability booking-link vague-time pay-question injection reschedule rounds rejection offer ghost"
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

case "${1:-slots}" in
  --list) echo "$SCENARIOS" | tr ' ' '\n'; exit 0 ;;
  --stop) stop; exit 0 ;;
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
scripts/demo-rehearsal.sh --keep --no-docker --api-port "$API_PORT" --forms-port "$FORMS_PORT"
API_ORIGIN="http://127.0.0.1:$API_PORT" WEB_PORT="$WEB_PORT" \
  setsid pnpm -F @wma/web dev > data/logs/web.log 2>&1 < /dev/null &
until curl -fs -o /dev/null "http://localhost:$WEB_PORT" 2>/dev/null; do sleep 1; done

cat <<DONE

Gauntlet Jobs is running, scenario: $scenario

1. Open http://localhost:$WEB_PORT and sign in as the demo user: in the browser console run
     await fetch('/auth/demo', {method: 'POST', headers: {'x-demo-token': '$DEMO_LOGIN_TOKEN'}}); location.reload()
2. Start a run from the dashboard. The agent should apply to AI Engineer at Gauntlet Jobs.
3. Watch the fake mailbox (recruiter mail, the agent's messages to you, its replies):
     DATABASE_URL=$DATABASE_URL pnpm gauntlet:mail
   To accept an interview time, open the confirm link in the agent's message to you.
4. Logs are in data/logs. Stop everything with: scripts/gauntlet.sh --stop
DONE
