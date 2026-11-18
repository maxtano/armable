#!/bin/bash
# A compressed copy of the database every night, keeping the last 7.
set -euo pipefail
cd /opt/armable/infra/gcp
docker compose exec -T db pg_dump -U armable armable | gzip > "/opt/armable-data/backups/armable-$(date +%F).sql.gz"
ls -1t /opt/armable-data/backups/armable-*.sql.gz | tail -n +8 | xargs -r rm --
