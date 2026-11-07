# Local development

Requires Node 22+, pnpm and Docker.

## Start Postgres

```bash
docker compose up -d
```

This starts Postgres 16 as `wma-postgres` on localhost:5432 (user `wma`, password `wma`, database `wma`). If a container with that name is already running, skip this step.

## Configure

Copy `.env.example` to `.env` and fill in the keys you have. `DATABASE_URL` defaults to `postgres://wma:wma@localhost:5432/wma`. `APP_DB_PASSWORD` (default `wma_app`) is the password of the non-owner application role created by the migration.

## Install and migrate

```bash
pnpm install
pnpm db:migrate
```

Migrations run as the owner `wma`. They create the tables, enable and force row-level security, and create the `wma_app` role. The application connects as `wma_app`; the owner is for migrations and test cleanup only.

Other database scripts:

- `pnpm db:generate` writes a new migration after a change to `packages/db/src/schema.ts`.
- `pnpm db:check` verifies the migration history is consistent.

## Run the checks

```bash
scripts/db-test-reset.sh   # drop, recreate and migrate the wma_test database
pnpm typecheck
pnpm lint
pnpm test
```

`scripts/db-test-reset.sh --help` lists its flags (`--keep` to keep an existing database, `--no-migrate`, `--db`, `--container`). It refuses to touch the `wma` database. The database integration tests in `packages/db` use `wma_test` (override with `TEST_DATABASE_URL`) and fail with a clear message if it has not been migrated.

## Run the apps

```bash
pnpm --filter @wma/api dev      # http://localhost:3000/health
pnpm --filter @wma/web dev      # http://localhost:5173 (proxies /api, /auth, /confirm and /captcha to the API; a production reverse proxy must route the same four prefixes)
pnpm --filter @wma/worker dev
```

## Vault master key

`VAULT_MASTER_KEY` is the base64 encoding of 32 random bytes; it wraps each tenant's data key, which in turn encrypts stored credentials (Google refresh tokens, ATS passwords). Generate one with `openssl rand -base64 32` and put it in `.env`. The api and worker call `assertVaultConfigured()` at startup and exit non-zero with `vault: VAULT_MASTER_KEY missing or not 32 bytes` if it is absent or the wrong length. Losing or changing the key makes existing stored secrets unreadable (reported as `corrupt`); rotating it is a manual runbook, not supported in the app. The db tests set their own fixed key and need nothing in `.env`.
