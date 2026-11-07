#!/usr/bin/env bash
# Brings the demo up from nothing, optionally runs the e2e suite, prints timings and stops
# whatever it started. Safe to run repeatedly: Postgres, the seed and the migrations are
# idempotent, and a service that is already answering is reused (and left running).
set -euo pipefail

CONTAINER="wma-postgres"
API_PORT="${PORT:-3000}"
FORMS_PORT="${DEMO_FORMS_PORT:-4310}"
LOG_DIR="./data/logs"
WAIT_S=90
RUN_E2E=0
KEEP=0
SEED=1
DOCKER=1

usage() {
  cat <<U
Usage: scripts/demo-rehearsal.sh [options]
  --e2e              Run 'pnpm test:e2e' after the services are healthy
  --keep             Leave the api and worker running when done
  --no-seed          Skip 'pnpm seed:demo'
  --no-docker        Do not start Postgres (use the DATABASE_URL already reachable)
  --container NAME   Postgres container name (default: $CONTAINER)
  --api-port N       API port (default: \$PORT or $API_PORT)
  --forms-port N     Fixture form server port (default: \$DEMO_FORMS_PORT or $FORMS_PORT)
  --log-dir DIR      Where api.log and worker.log go (default: $LOG_DIR)
  --wait N           Seconds to wait for each service (default: $WAIT_S)
  -h, --help         Show this help
Requires .env with VAULT_MASTER_KEY and SESSION_SECRET. DEMO_LOGIN_TOKEN is generated for
this run when .env does not set it. NODE_ENV must not be 'production'.
U
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --e2e) RUN_E2E=1; shift ;;
    --keep) KEEP=1; shift ;;
    --no-seed) SEED=0; shift ;;
    --no-docker) DOCKER=0; shift ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --forms-port) FORMS_PORT="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    --wait) WAIT_S="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
mkdir -p "$LOG_DIR"
if [[ -f .env ]]; then set -a; . ./.env; set +a; fi
# After the .env load, so a production setting in either place refuses before anything is touched.
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "refusing to run with NODE_ENV=production" >&2
  exit 2
fi
for var in VAULT_MASTER_KEY SESSION_SECRET; do
  if [[ -z "${!var:-}" ]]; then echo "$var is not set (see .env.example)" >&2; exit 2; fi
done
export DEMO_LOGIN_TOKEN="${DEMO_LOGIN_TOKEN:-rehearsal-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}"
export DEMO_FORMS_PORT="$FORMS_PORT" PORT="$API_PORT"
export SIMULATED_RECRUITER_DELAY_S="${SIMULATED_RECRUITER_DELAY_S:-5}"

STARTED_PIDS=()
STARTED_DB=0
declare -a TIMING_NAMES=() TIMING_VALUES=()
now() { date +%s.%N; }
T_ALL=$(now)
mark() { # name start
  TIMING_NAMES+=("$1"); TIMING_VALUES+=("$(printf '%.1f' "$(echo "$(now) - $2" | bc -l)")")
}

cleanup() {
  local code=$?
  if [[ "$KEEP" == "0" ]]; then
    for pid in "${STARTED_PIDS[@]:-}"; do
      [[ -n "$pid" ]] && kill -- "-$pid" 2>/dev/null || true
    done
    for pid in "${STARTED_PIDS[@]:-}"; do # give them a moment to release their ports
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    done
    [[ "$STARTED_DB" == "1" ]] && echo "note: Postgres was started by this script and is left running"
  else
    echo "left running: pids ${STARTED_PIDS[*]:-none} (stop with: kill -- -<pid>)"
  fi
  mark total "$T_ALL"
  echo "--- timings (seconds) ---"
  for i in "${!TIMING_NAMES[@]}"; do printf '%-14s %s\n' "${TIMING_NAMES[$i]}" "${TIMING_VALUES[$i]}"; done
  exit "$code"
}
trap cleanup EXIT

wait_for() { # name url
  local t0; t0=$(now)
  local deadline=$((SECONDS + WAIT_S))
  until curl -fs -o /dev/null "$2" < /dev/null 2>&1; do
    if (( SECONDS >= deadline )); then echo "$1 did not become healthy within ${WAIT_S}s (see $LOG_DIR)" >&2; exit 1; fi
    sleep 1
  done
  mark "$1" "$t0"
}

start_service() { # name url command...
  local name="$1" url="$2"; shift 2
  if curl -fs -o /dev/null "$url" < /dev/null 2>&1; then
    echo "$name already running, reusing it"
    return
  fi
  setsid "$@" > "$LOG_DIR/$name.log" 2>&1 < /dev/null &
  STARTED_PIDS+=("$!")
  echo "$name started (pid $!, log $LOG_DIR/$name.log)"
}

# 1. Postgres
if [[ "$DOCKER" == "1" ]]; then
  t0=$(now)
  if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != "true" ]]; then
    docker compose up -d postgres < /dev/null
    STARTED_DB=1
  fi
  deadline=$((SECONDS + WAIT_S))
  until docker exec "$CONTAINER" pg_isready -U wma -d wma < /dev/null > /dev/null 2>&1; do
    if (( SECONDS >= deadline )); then echo "Postgres not ready" >&2; exit 1; fi
    sleep 1
  done
  mark postgres "$t0"
fi

# 2. Migrate and seed
t0=$(now); pnpm --silent db:migrate < /dev/null; mark migrate "$t0"
if [[ "$SEED" == "1" ]]; then
  # The e2e suite needs its fixtures (applied, interviewing, offer, running run): provision them
  # before it runs, so no scenario can silently disappear from a green rehearsal.
  SEED_ARGS=()
  [[ "$RUN_E2E" == "1" ]] && SEED_ARGS+=(--scenarios)
  t0=$(now); pnpm --silent seed:demo "${SEED_ARGS[@]}" < /dev/null; mark seed "$t0"
fi

# 3. api and worker
start_service api "http://127.0.0.1:$API_PORT/health" pnpm -F @wma/api start
start_service worker "http://127.0.0.1:$FORMS_PORT/forms/greenhouse/form.html" pnpm -F @wma/worker start
wait_for api "http://127.0.0.1:$API_PORT/health"
wait_for worker "http://127.0.0.1:$FORMS_PORT/forms/greenhouse/form.html"

# 4. Sign in once to prove the demo login works against this build
t0=$(now)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Demo-Token: $DEMO_LOGIN_TOKEN" \
  "http://127.0.0.1:$API_PORT/auth/demo" < /dev/null || true)
if [[ "$code" != "200" ]]; then echo "demo sign-in answered $code (is the demo tenant seeded and DEMO_LOGIN_TOKEN the same in the running api?)" >&2; exit 1; fi
mark demo-login "$t0"

# 5. e2e
if [[ "$RUN_E2E" == "1" ]]; then
  t0=$(now); pnpm test:e2e < /dev/null; mark e2e "$t0"
fi
echo "rehearsal ok"
