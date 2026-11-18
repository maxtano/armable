#!/bin/bash
# Pull the latest code and app image, and restart only what changed. Run every 10 minutes by cron.
set -uo pipefail
cd /opt/armable && git pull --ff-only -q || true
cd /opt/armable/infra/gcp
if docker compose pull -q app 2>/dev/null; then docker compose up -d --remove-orphans
else
  # No published image: rebuild here only when the code changed since the last build.
  head=$(git -C /opt/armable rev-parse HEAD); last=$(cat /opt/armable-data/built 2>/dev/null || true)
  if [ "$head" != "$last" ]; then docker compose up -d --build --remove-orphans && echo "$head" > /opt/armable-data/built; fi
fi
docker image prune -f >/dev/null
