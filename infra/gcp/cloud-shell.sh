#!/bin/bash
# Creates Armable's server on Google Cloud's free tier. Run it in Google Cloud Shell, which is already signed in:
#
#   curl -fsSL https://raw.githubusercontent.com/maxtano/armable/main/infra/gcp/cloud-shell.sh | bash
#
# Safe to run again: it skips whatever already exists. Change the settings below by setting them first,
# e.g.  DOMAIN=app.example.com bash cloud-shell.sh
set -euo pipefail

DOMAIN="${DOMAIN:-app.armable.ai}"
REGION="${REGION:-us-central1}"          # Free only in us-central1, us-east1 or us-west1.
ZONE="${ZONE:-${REGION}-a}"
NAME="${NAME:-armable}"
REPO="${REPO:-https://github.com/maxtano/armable.git}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
[ -n "$PROJECT" ] || { echo "Choose a project first:  gcloud config set project YOUR_PROJECT_ID"; exit 1; }
case "$REGION" in us-central1|us-east1|us-west1) ;; *) echo "Warning: $REGION is not in the free tier. Use us-central1, us-east1 or us-west1."; esac

say "Project $PROJECT, server $NAME in $ZONE, address $DOMAIN"
gcloud services enable compute.googleapis.com --project "$PROJECT"

say "A fixed public address, so DNS never has to change"
gcloud compute addresses describe "$NAME-ip" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute addresses create "$NAME-ip" --region "$REGION" --network-tier STANDARD --project "$PROJECT"
IP=$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" --project "$PROJECT" --format='value(address)')

say "Open the web ports"
gcloud compute firewall-rules describe "$NAME-web" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute firewall-rules create "$NAME-web" --project "$PROJECT" --allow tcp:80,tcp:443,udp:443 --target-tags "$NAME-web" --description "Armable: HTTP and HTTPS"

say "The server: e2-micro, 30 GB standard disk, Debian 12"
startup=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/maxtano/armable/main/infra/gcp/vm-startup.sh" -o "$startup"
if gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute instances add-metadata "$NAME" --zone "$ZONE" --project "$PROJECT" --metadata "domain=$DOMAIN,repo=$REPO" --metadata-from-file "startup-script=$startup"
  echo "The server already exists; its settings are updated. Restart it to apply:  gcloud compute instances reset $NAME --zone $ZONE"
else
  gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
    --machine-type e2-micro --network-tier STANDARD --address "$IP" \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-standard \
    --tags "$NAME-web" \
    --metadata "domain=$DOMAIN,repo=$REPO" --metadata-from-file "startup-script=$startup"
fi
rm -f "$startup"

say "Done. One step left: point $DOMAIN at this server."
cat <<EOF

  In Cloudflare, open your domain, then DNS, Records, Add record:

      Type   A
      Name   ${DOMAIN%%.*}
      IPv4   $IP
      Proxy  DNS only (grey cloud)

  The server installs itself in the next 5 to 15 minutes. Once DNS points here it gets its HTTPS certificate,
  and Armable opens at https://$DOMAIN

  Watch it start:    gcloud compute ssh $NAME --zone $ZONE -- sudo tail -f /var/log/armable-startup.log
  Edit settings:     gcloud compute ssh $NAME --zone $ZONE -- sudo nano /opt/armable-data/.env
EOF
