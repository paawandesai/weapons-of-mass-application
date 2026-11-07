#!/usr/bin/env bash
# The demo recording stack: a fresh wma_demo database, plain seed, api, worker (fixture forms) and
# web on their own ports, so the dev stack on 3000/4310/5173 is untouched. Every `up` starts from
# nothing, which the recording needs: a run happens once per day and the recruiter answers once.
#
#   scripts/demo/stack.sh up      reset the database, seed, start api, worker and web
#   scripts/demo/stack.sh down    stop what `up` started
#   scripts/demo/stack.sh status  ports and health
#
# Ports: API_PORT (3920), FORMS_PORT (4320), WEB_PORT (5190). SIMULATED_RECRUITER_DELAY_S (200)
# keeps the Applied column visible before the recruiters answer; the wait is cut from the footage.
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="wma_demo"
API_PORT="${API_PORT:-3920}"
FORMS_PORT="${FORMS_PORT:-4320}"
WEB_PORT="${WEB_PORT:-5190}"
LOG_DIR="data/demo-logs"
PIDFILE="$LOG_DIR/stack.pids"

listening() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true; }

down() {
  for port in "$API_PORT" "$FORMS_PORT" "$WEB_PORT"; do
    pids=$(listening "$port")
    if [[ -n "$pids" ]]; then kill $pids 2>/dev/null && echo "stopped port $port"; fi
  done
  if [[ -f "$PIDFILE" ]]; then
    while read -r pid; do kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; done < "$PIDFILE"
    rm -f "$PIDFILE"
  fi
  sleep 1
}

status() {
  for port in "$API_PORT" "$FORMS_PORT" "$WEB_PORT"; do
    if [[ -n "$(listening "$port")" ]]; then echo "port $port: listening"; else echo "port $port: free"; fi
  done
  curl -fs "http://127.0.0.1:$API_PORT/health" && echo
}

case "${1:-}" in
  down) down; exit 0 ;;
  status) status; exit 0 ;;
  up) ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

down
mkdir -p "$LOG_DIR"
scripts/db-test-reset.sh --db "$DB"

export DATABASE_URL="postgres://wma:wma@localhost:5432/$DB"
export DEMO_FORMS_PORT="$FORMS_PORT" PORT="$API_PORT" WEB_PORT="$WEB_PORT"
export SIMULATED_RECRUITER_DELAY_S="${SIMULATED_RECRUITER_DELAY_S:-200}"
scripts/demo-rehearsal.sh --keep --no-docker --api-port "$API_PORT" --forms-port "$FORMS_PORT" \
  --web-port "$WEB_PORT" --log-dir "$LOG_DIR" | tee "$LOG_DIR/rehearsal.log" \
  | grep -oE 'pids [0-9 ]+' | tr ' ' '\n' | grep -E '^[0-9]+$' > "$PIDFILE" || true

API_ORIGIN="http://127.0.0.1:$API_PORT" WEB_PORT="$WEB_PORT" \
  setsid pnpm -F @wma/web dev > "$LOG_DIR/web.log" 2>&1 < /dev/null &
echo "$!" >> "$PIDFILE"
until curl -fs -o /dev/null "http://localhost:$WEB_PORT" 2>/dev/null; do sleep 1; done
echo "demo stack up: web http://localhost:$WEB_PORT, api :$API_PORT, forms :$FORMS_PORT, db $DB"
