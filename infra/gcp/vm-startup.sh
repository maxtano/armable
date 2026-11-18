#!/bin/bash
# Runs as root on every boot of the Armable server. Safe to run again: each step checks before it acts.
# It adds swap, installs Docker, fetches the repository, writes settings once, and starts the app,
# then schedules updates every 10 minutes and a nightly database backup.
set -euo pipefail
exec > >(tee -a /var/log/armable-startup.log) 2>&1
echo "[armable] startup $(date -Is)"

meta() { curl -fs -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }
DOMAIN="$(meta domain)"; REPO="$(meta repo)"; EGRESS="$(meta egress_mbit)"; PROXY="$(meta behind_proxy)"
REPO="${REPO:-https://github.com/maxtano/armable.git}"
DATA=/opt/armable-data; CODE=/opt/armable

# 1. Swap, so 1 GB of memory is enough for the app, the database and an occasional build.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. A speed limit on everything the server sends. Armable sends small messages; this stops anyone from
#    using it to send a lot of data, which is the one thing Google charges for by volume.
IFACE="$(ip route show default 2>/dev/null | awk '{print $5; exit}' || true)"
if [ -n "$IFACE" ] && [ "${EGRESS:-20}" != "0" ]; then
  if tc qdisc replace dev "$IFACE" root tbf rate "${EGRESS:-20}mbit" burst 64kb latency 50ms; then
    echo "[armable] outgoing traffic limited to ${EGRESS:-20} Mbit/s on $IFACE"
  else echo "[armable] WARNING: could not set the outgoing speed limit"; fi
elif [ -n "$IFACE" ]; then tc qdisc del dev "$IFACE" root 2>/dev/null || true; fi

# 3. Docker and git.
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y ca-certificates curl git
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }

# 4. The code. update.sh (step 6) checks out the release this server should run.
[ -d "$CODE/.git" ] || git clone -q --filter=blob:none "$REPO" "$CODE"

# 5. Settings, written once and kept across updates. Edit /opt/armable-data/.env to add Google sign-in or feedback alerts.
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
# Behind Cloudflare there are two proxies (Cloudflare, then Caddy); otherwise one. This keeps client addresses right.
sed -i '/^TRUST_PROXY=/d' "$DATA/.env"; echo "TRUST_PROXY=$([ "$PROXY" = cloudflare ] && echo 2 || echo 1)" >> "$DATA/.env"
ln -sf "$DATA/.env" "$CODE/infra/gcp/.env"

# 6. Start the release this server should run (see update.sh).
bash "$CODE/infra/gcp/update.sh"

# 7. Updates every 10 minutes, a backup every night, both logged.
cat > /etc/cron.d/armable <<EOF
*/10 * * * * root $CODE/infra/gcp/update.sh >> /var/log/armable-update.log 2>&1
17 3 * * * root $CODE/infra/gcp/backup.sh >> /var/log/armable-backup.log 2>&1
EOF
chmod +x "$CODE/infra/gcp/update.sh" "$CODE/infra/gcp/backup.sh"
echo "[armable] running at https://${DOMAIN:-app.armable.ai}"
