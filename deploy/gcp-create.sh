#!/usr/bin/env bash
# Creates the Google Cloud project and the free-tier server for the CRM.
# Run this yourself (it links a billing account, which only the account owner should do):
#   bash deploy/gcp-create.sh
# Free tier: one e2-micro VM in us-east1, 30 GB standard disk, 1 GB egress/month.
# A $1 budget alert emails you if anything is ever billed.
set -euo pipefail

BILLING_ACCOUNT="${BILLING_ACCOUNT:-011691-E43085-627D13}"
PROJECT_ID="${PROJECT_ID:-skip-jackson-crm-$(openssl rand -hex 2)}"
ZONE="${ZONE:-us-east1-b}"     # South Carolina: free-tier region closest to Georgia
VM="${VM:-skip-crm}"

echo "==> Creating project $PROJECT_ID"
gcloud projects create "$PROJECT_ID" --name="Skip Jackson CRM"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs"
gcloud services enable compute.googleapis.com billingbudgets.googleapis.com iap.googleapis.com

echo "==> Budget alert at \$1 (emails the billing account admins)"
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
  --display-name="Skip Jackson CRM - alert on any charge" \
  --budget-amount=1USD --filter-projects="projects/$PROJECT_ID" \
  --threshold-rule=percent=0.01 --threshold-rule=percent=1.0 >/dev/null

echo "==> Firewall: web open, SSH only through Google's IAP tunnel"
gcloud compute firewall-rules delete default-allow-rdp default-allow-ssh --quiet 2>/dev/null || true
gcloud compute firewall-rules create allow-web --network=default --direction=INGRESS \
  --allow=tcp:80,tcp:443 --target-tags=web --source-ranges=0.0.0.0/0
gcloud compute firewall-rules create allow-ssh-iap --network=default --direction=INGRESS \
  --allow=tcp:22 --target-tags=web --source-ranges=35.235.240.0/20

echo "==> Creating the free-tier server"
gcloud compute instances create "$VM" --zone="$ZONE" \
  --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --tags=web --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata=enable-oslogin=TRUE

IP=$(gcloud compute instances describe "$VM" --zone="$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
echo
echo "Done. Project: $PROJECT_ID   Server IP: $IP"
echo "Tell Claude it's ready; it will finish the setup from here."
