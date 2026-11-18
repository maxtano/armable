#!/bin/bash
# Bring the server to the release it should run, and restart only what changed. Runs at boot and every 10 minutes.
#
#   channel "stable" (the default): the newest release tag, such as v1.2.3. A push to main never reaches it;
#                                   tagging a release does.
#   channel "edge":                 the tip of main, for trying changes before they are released.
#
# Set the channel in terraform.tfvars and run ./deploy.sh again.
set -uo pipefail
CODE=/opt/armable; DATA=/opt/armable-data
meta() { curl -fs -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }
CHANNEL="$(meta channel)"; CHANNEL="${CHANNEL:-stable}"

# 1. The code for that release. Release tags look like v1.2.3; anything else (v1.3.0-rc.1) is skipped.
git -C "$CODE" fetch -q --tags --force origin main || echo "[armable] could not reach GitHub; staying on the current release"
if [ "$CHANNEL" = edge ]; then target=origin/main; image=edge
else
  target="$(git -C "$CODE" tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)"; image="$target"
  if [ -z "$target" ]; then echo "[armable] no release tagged yet; running main"; target=origin/main; image=edge; fi
fi
before="$(git -C "$CODE" rev-parse HEAD)"
git -C "$CODE" checkout -q --detach "$target" || exit 1
[ "$before" = "$(git -C "$CODE" rev-parse HEAD)" ] || echo "[armable] $(date -Is) now on $target"
sed -i '/^ARMABLE_IMAGE_TAG=/d' "$DATA/.env"; echo "ARMABLE_IMAGE_TAG=$image" >> "$DATA/.env"

# 2. The app. Use the image GitHub built for that release; if there is none yet, build it here once.
cd "$CODE/infra/gcp"
if docker compose pull -q app 2>/dev/null; then docker compose up -d --remove-orphans
else
  head="$(git -C "$CODE" rev-parse HEAD)"; last="$(cat "$DATA/built" 2>/dev/null || true)"
  if [ "$head" != "$last" ]; then
    echo "[armable] image $image not available, building on this server"
    docker compose up -d --build --remove-orphans && echo "$head" > "$DATA/built"
  else docker compose up -d --remove-orphans; fi
fi
docker image prune -f >/dev/null
