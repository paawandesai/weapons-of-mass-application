# Deployment

One DigitalOcean droplet runs everything (PRD, "Deployment"): Postgres, the API, the worker and
Caddy serving the built web app with automatic TLS. Files live in `deploy/`; the one command is
`scripts/deploy.sh`.

## Layout on the host

| Path | What |
|---|---|
| `/opt/wma/.env` | Secrets and public URLs. Written once by the first deploy, never overwritten. |
| `/opt/wma/src` | The shipped tree (replaced on every deploy). |
| Docker volumes `pgdata`, `files`, `caddy_data` | Database, the resume and PDF store shared by the API and worker, certificates. |

The API and worker both read and write `FILE_STORE_DIR`, so they share one volume on one host.
Splitting them across machines needs object storage first.

## Services (`deploy/docker-compose.yml`)

- `postgres`: Postgres 16.
- `migrate`: one-shot, runs `pnpm db:migrate` as the owner role, then exits. The API and worker
  start only after it succeeds.
- `api`: `deploy/Dockerfile` target `api`, Node 22, runs `tsx` on the sources.
- `worker`: `deploy/Dockerfile.worker` on Playwright's image (Chromium and its libraries). Keep the
  image tag in step with the `playwright` version in `apps/worker/package.json`. `shm_size: 1g`
  for Chromium.
- `web`: Caddy with the Vite build in `/srv`. `deploy/Caddyfile` routes `/api`, `/auth`,
  `/confirm`, `/captcha` and `/health` to the API and serves the single-page app for everything
  else, the same four prefixes the dev proxy forwards.

## First deploy

```bash
scripts/deploy.sh --create
```

Creates `wma-prod` (`s-2vcpu-4gb`, `sfo3`, Ubuntu 24.04) with cloud-init that installs Docker, a
2 GB swap file and `ufw` (22, 80, 443). The hostname is `<ip-with-dashes>.sslip.io`; Caddy gets the
certificate from Let's Encrypt on first request. The script then:

1. Generates `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `VAULT_MASTER_KEY` and `SESSION_SECRET`,
   copies the Anthropic key and Google client from `~/.config/agentforge/jobs-*`, and writes
   `/opt/wma/.env` with `NODE_ENV=production` and the public URLs. A mirror goes to
   `~/.config/agentforge/jobs-droplet-credentials` (mode 0600). Losing `VAULT_MASTER_KEY` makes
   every stored credential unreadable (`docs/setup/local-dev.md`, "Vault master key").
2. Ships the working tree (tracked and untracked files, nothing ignored) with `tar` over SSH.
   `--ref main` ships a committed tree instead.
3. Builds the images on the host and starts the stack.
4. Waits for `https://<host>/health`.

Then add the printed origin and redirect URI to the Google OAuth client in GCP project
`fretboard-423808` (APIs & Services, Credentials). Until that is done, Google sign-in fails with
`redirect_uri_mismatch`.

## Later deploys

```bash
scripts/deploy.sh
```

Finds the droplet by name, ships the tree, rebuilds what changed, restarts. `--no-build` restarts
with the images already on the host. Migrations run on every start and are idempotent.

## Operating

```bash
ssh root@<ip> 'cd /opt/wma/src && docker compose -f deploy/docker-compose.yml --env-file /opt/wma/.env logs -f --tail=100 api worker'
```

- `DEMO_LOGIN_TOKEN` and `DEMO_FORMS_PORT` are not set in production; demo sign-in and the fixture
  forms are off. `NODE_ENV=production` also disables demo sign-in regardless.
- Spend bounds: `JUDGE_CAP_PER_RUN=120`, `MAX_PER_COMPANY_PER_RUN=1` in `/opt/wma/.env`. Edit and
  `scripts/deploy.sh --no-build` to apply.
- The Google consent screen is in Testing mode: refresh tokens expire after seven days, so the
  Gmail and Calendar connection needs re-authorizing weekly until the app is published.
- Backups: `docker compose exec postgres pg_dump -U wma wma` and the `files` volume. Nothing is
  automated yet.
