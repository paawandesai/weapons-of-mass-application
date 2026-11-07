#!/usr/bin/env bash
# Creates (or recreates) the integration-test database and applies migrations to it.
# Safe to run repeatedly. Never touches the dev database.
set -euo pipefail

CONTAINER="wma-postgres"
DB="wma_test"
PG_USER="wma"
PG_PASSWORD="wma"
HOST="localhost"
PORT="5432"
KEEP=0
MIGRATE=1

usage() {
  cat <<U
Usage: scripts/db-test-reset.sh [options]
  --container NAME   Postgres container to exec into (default: $CONTAINER)
  --db NAME          Test database name (default: $DB; 'wma' and 'postgres' are refused)
  --keep             Do not drop an existing database, only create if missing, then migrate
  --no-migrate       Skip applying migrations
  -h, --help         Show this help
By default the database is dropped and recreated, then migrated.
U
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-migrate) MIGRATE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$DB" == "wma" || "$DB" == "postgres" || ! "$DB" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "refusing database name '$DB'" >&2
  exit 2
fi

psql_admin() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres -tA "$@" < /dev/null; }

exists=$(psql_admin -c "select 1 from pg_database where datname = '$DB'")
if [[ "$exists" == "1" && "$KEEP" == "0" ]]; then
  psql_admin -c "drop database \"$DB\" with (force)" > /dev/null
  exists=""
fi
if [[ "$exists" != "1" ]]; then
  psql_admin -c "create database \"$DB\" owner \"$PG_USER\"" > /dev/null
  echo "created database $DB"
fi

if [[ "$MIGRATE" == "1" ]]; then
  cd "$(dirname "$0")/.."
  DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@$HOST:$PORT/$DB" pnpm --silent db:migrate < /dev/null
fi
echo "$DB ready"
