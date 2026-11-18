#!/bin/bash
# Runs as root on every boot of the Armable server. Safe to run again: each step checks before it acts.
# It adds swap, installs Docker, fetches the repository, writes settings once, and starts the app,
# then schedules updates every 10 minutes and a nightly database backup.
set -euo pipefail
exec > >(tee -a /var/log/armable-startup.log) 2>&1
echo "[armable] startup $(date -Is)"

meta() { curl -fs -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }
DOMAIN="$(meta domain)"; REPO="$(meta repo)"
REPO="${REPO:-https://github.com/maxtano/armable.git}"
DATA=/opt/armable-data; CODE=/opt/armable

# 1. Swap, so 1 GB of memory is enough for the app, the database and an occasional build.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Docker and git.
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y ca-certificates curl git
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }

# 3. The code: the repository, kept up to date.
if [ -d "$CODE/.git" ]; then git -C "$CODE" pull --ff-only || true; else git clone --depth 1 "$REPO" "$CODE"; fi

# 4. Settings, written once and kept across updates. Edit /opt/armable-data/.env to add Google sign-in or feedback alerts.
mkdir -p "$DATA/postgres" "$DATA/caddy" "$DATA/backups"
if [ ! -f "$DATA/.env" ]; then
  umask 077
  cat > "$DATA/.env" <<EOF
DOMAIN=${DOMAIN:-app.armable.ai}
POSTGRES_PASSWORD=$(openssl rand -hex 24)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FEEDBACK_WEBHOOK_URL=
ADMIN_EMAILS=
EOF
fi
ln -sf "$DATA/.env" "$CODE/infra/gcp/.env"

# 5. Start. Use the image GitHub built; if it cannot be pulled, build it here (slower, but it works).
cd "$CODE/infra/gcp"
if docker compose pull app; then docker compose up -d --remove-orphans
else echo "[armable] image not available, building on this server"; docker compose up -d --build --remove-orphans; fi

# 6. Updates every 10 minutes, a backup every night, both logged.
cat > /etc/cron.d/armable <<EOF
*/10 * * * * root $CODE/infra/gcp/update.sh >> /var/log/armable-update.log 2>&1
17 3 * * * root $CODE/infra/gcp/backup.sh >> /var/log/armable-backup.log 2>&1
EOF
chmod +x "$CODE/infra/gcp/update.sh" "$CODE/infra/gcp/backup.sh"
echo "[armable] running at https://${DOMAIN:-app.armable.ai}"
