#!/usr/bin/env bash
# Deploys the stack in deploy/docker-compose.yml to one DigitalOcean droplet (PRD: one host runs
# everything). Idempotent: re-running ships the current tree and rebuilds what changed.
#
# First time:   scripts/deploy.sh --create
# Afterwards:   scripts/deploy.sh            (finds the droplet by name)
#
# Reads from ~/.config/agentforge: jobs-anthropic_key, jobs-google_client_id,
# jobs-google_client_secret. Generated secrets (database passwords, vault key, session secret)
# are written once to /opt/wma/.env on the host and mirrored to
# ~/.config/agentforge/jobs-droplet-credentials (mode 0600). Losing VAULT_MASTER_KEY makes every
# stored credential unreadable, so keep that file.
set -euo pipefail

NAME="wma-prod"
REGION="sfo3"
SIZE="s-2vcpu-4gb"
IMAGE="ubuntu-24-04-x64"
CREATE=0
HOST=""
REF=""            # git ref to ship; default is the working tree (tracked + untracked, not ignored)
BUILD=1
WAIT_S=300
SECRETS_DIR="${AGENTFORGE_DIR:-$HOME/.config/agentforge}"
CREDS_FILE="$SECRETS_DIR/jobs-droplet-credentials"
SSH_KEY_PUB="${SSH_KEY_PUB:-$HOME/.ssh/id_ed25519.pub}"

usage() {
  cat <<U
Usage: scripts/deploy.sh [options]
  --create           Create the droplet (fails if one named NAME already exists)
  --host IP          Deploy to this IP instead of looking the droplet up by name
  --name NAME        Droplet name (default: $NAME)
  --region R         Region for --create (default: $REGION)
  --size S           Size for --create (default: $SIZE)
  --ref REF          Ship 'git archive REF' instead of the working tree
  --no-build         Skip the image build (restart with the images already on the host)
  --wait N           Seconds to wait for the health check (default: $WAIT_S)
  -h, --help         Show this help
U
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --create) CREATE=1; shift ;;
    --host) HOST="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --wait) WAIT_S="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
need doctl; need ssh; need git; need openssl
for f in jobs-anthropic_key jobs-google_client_id jobs-google_client_secret; do
  [[ -s "$SECRETS_DIR/$f" ]] || { echo "missing secret file: $SECRETS_DIR/$f" >&2; exit 1; }
done

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
rsh() { ssh "${SSH_OPTS[@]}" "root@$HOST" "$@"; }

# ---- droplet -----------------------------------------------------------------------------------
if [[ $CREATE -eq 1 ]]; then
  if doctl compute droplet list --format Name --no-header | grep -qx "$NAME"; then
    echo "droplet $NAME already exists; run without --create" >&2; exit 1
  fi
  fp=$(ssh-keygen -lf "$SSH_KEY_PUB" -E md5 | awk '{print $2}' | sed 's/^MD5://')
  key_id=$(doctl compute ssh-key list --format ID,FingerPrint --no-header | awk -v fp="$fp" '$2==fp{print $1}')
  if [[ -z "$key_id" ]]; then
    log "uploading $SSH_KEY_PUB to DigitalOcean"
    key_id=$(doctl compute ssh-key import "$NAME-deployer" --public-key-file "$SSH_KEY_PUB" --format ID --no-header)
  fi
  user_data=$(cat <<'CI'
#cloud-config
package_update: true
packages: [ufw, rsync]
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
  - ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
  - mkdir -p /opt/wma
CI
)
  log "creating droplet $NAME ($SIZE, $REGION)"
  doctl compute droplet create "$NAME" --region "$REGION" --size "$SIZE" --image "$IMAGE" \
    --ssh-keys "$key_id" --user-data "$user_data" --tag-name wma --wait --format ID,Name,PublicIPv4 --no-header
fi

if [[ -z "$HOST" ]]; then
  HOST=$(doctl compute droplet list --format Name,PublicIPv4 --no-header | awk -v n="$NAME" '$1==n{print $2}')
  [[ -n "$HOST" ]] || { echo "no droplet named $NAME; use --create or --host" >&2; exit 1; }
fi
SITE_HOST="${HOST//./-}.sslip.io"
log "host $HOST -> https://$SITE_HOST"

log "waiting for ssh"
for _ in $(seq 1 60); do rsh true 2>/dev/null && break; sleep 5; done
rsh true || { echo "ssh to $HOST failed" >&2; exit 1; }
log "waiting for cloud-init"
rsh 'cloud-init status --wait >/dev/null 2>&1 || true; command -v docker >/dev/null' \
  || { echo "docker not installed on $HOST" >&2; exit 1; }

# ---- secrets -----------------------------------------------------------------------------------
if ! rsh 'test -s /opt/wma/.env'; then
  log "writing /opt/wma/.env (first deploy)"
  gen() { openssl rand -base64 "$1" | tr -d '\n' | tr '+/' '-_'; }
  env_body=$(cat <<ENV
# Written by scripts/deploy.sh $(date -u +%FT%TZ). Do not commit.
NODE_ENV=production
SITE_HOST=$SITE_HOST
WEB_ORIGIN=https://$SITE_HOST
GOOGLE_REDIRECT_URI=https://$SITE_HOST/auth/google/callback
ANTHROPIC_API_KEY=$(tr -d '\n' < "$SECRETS_DIR/jobs-anthropic_key")
GOOGLE_CLIENT_ID=$(tr -d '\n' < "$SECRETS_DIR/jobs-google_client_id")
GOOGLE_CLIENT_SECRET=$(tr -d '\n' < "$SECRETS_DIR/jobs-google_client_secret")
POSTGRES_PASSWORD=$(gen 24)
APP_DB_PASSWORD=$(gen 24)
VAULT_MASTER_KEY=$(openssl rand -base64 32)
SESSION_SECRET=$(gen 48)
JUDGE_CAP_PER_RUN=120
MAX_PER_COMPANY_PER_RUN=1
ENV
)
  printf '%s\n' "$env_body" | rsh 'umask 077 && cat > /opt/wma/.env'
  ( umask 077; { echo "# Mirror of root@$HOST:/opt/wma/.env"; printf '%s\n' "$env_body"; } > "$CREDS_FILE" )
  log "credentials mirrored to $CREDS_FILE"
fi

# ---- code ------------------------------------------------------------------------------------
log "shipping ${REF:-working tree}"
rsh 'rm -rf /opt/wma/src && mkdir -p /opt/wma/src'
if [[ -n "$REF" ]]; then
  git archive --format=tar "$REF"
else
  git ls-files -co --exclude-standard -z | tar --null -cf - -T -
fi | rsh 'tar -xf - -C /opt/wma/src'
rsh 'ln -sf /opt/wma/.env /opt/wma/src/deploy/.env'

# ---- run -------------------------------------------------------------------------------------
compose='cd /opt/wma/src && docker compose -f deploy/docker-compose.yml --env-file /opt/wma/.env'
if [[ $BUILD -eq 1 ]]; then
  log "building images on the host (several minutes the first time)"
  rsh "$compose build --pull" 2>&1 | tail -5
fi
log "starting stack"
rsh "$compose up -d --remove-orphans"
rsh "$compose ps"

log "waiting for https://$SITE_HOST/health"
deadline=$((SECONDS + WAIT_S))
until curl -fsS --max-time 10 "https://$SITE_HOST/health" >/dev/null 2>&1; do
  if (( SECONDS > deadline )); then
    echo "health check did not pass in ${WAIT_S}s; logs:" >&2
    rsh "$compose logs --tail=40 api web" >&2
    exit 1
  fi
  sleep 5
done
log "up: https://$SITE_HOST"
cat <<NEXT
Next: add to the Google OAuth client (GCP project fretboard-423808):
  Authorized JavaScript origin:  https://$SITE_HOST
  Authorized redirect URI:       https://$SITE_HOST/auth/google/callback
NEXT
