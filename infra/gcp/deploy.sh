#!/bin/bash
# Sets up or updates Armable on Google Cloud, with Terraform. Run it in Google Cloud Shell, which is signed in
# and has Terraform:
#
#   git clone https://github.com/maxtano/armable && cd armable/infra/gcp && ./deploy.sh
#
# It finds your project and billing account, keeps Terraform's state in a private bucket in your project,
# writes terraform.tfvars once (kept out of git), shows the plan, and applies it when you agree.
set -euo pipefail
cd "$(dirname "$0")"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Choose your project first:  gcloud config set project YOUR_PROJECT_ID"; exit 1; }

echo "Project: $PROJECT"
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com cloudbilling.googleapis.com \
  billingbudgets.googleapis.com storage.googleapis.com --project "$PROJECT"

BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
[ -n "$BILLING" ] || { echo "This project has no billing account. Link one under Billing in the console, then run this again."; exit 1; }
echo "Billing account: $BILLING"

BUCKET="${PROJECT}-tfstate"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location us-central1 --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://$BUCKET" --versioning
fi

if [ ! -f terraform.tfvars ]; then
  printf 'project_id      = "%s"\nbilling_account = "%s"\n' "$PROJECT" "$BILLING" > terraform.tfvars
  echo "Wrote terraform.tfvars. Edit it to change the cap, the domain or the speed limit."
fi

terraform init -input=false -reconfigure -backend-config="bucket=$BUCKET"
terraform apply
terraform output -raw next
