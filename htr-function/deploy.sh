#!/usr/bin/env bash
# Einmalig in der Google Cloud Shell ausfuehren (Browser-Terminal, nichts zu installieren):
#   git clone https://github.com/HeTec-IT/Sales.HeTec && cd Sales.HeTec/htr-function && bash deploy.sh
set -euo pipefail
PROJECT="${1:-o2-pencil-selling}"
MODEL="${HTR_MODEL:-gemini-3.5-flash}"
LOCATION="${HTR_LOCATION:-eu}"
gcloud config set project "$PROJECT"
gcloud services enable aiplatform.googleapis.com cloudfunctions.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud functions deploy handwritingToText --gen2 --runtime=nodejs22 --region=europe-west3 \
  --source=. --entry-point=handwritingToText --trigger-http --allow-unauthenticated \
  --memory=512MiB --timeout=60s --max-instances=5 \
  --set-env-vars "HTR_MODEL=${MODEL},HTR_LOCATION=${LOCATION},HTR_PROJECTS=o2-pencil-selling,pencil-selling-telekom"
# Die Funktion darf Vertex AI aufrufen (Dienstkonto der Funktion)
SA=$(gcloud functions describe handwritingToText --gen2 --region=europe-west3 --format='value(serviceConfig.serviceAccountEmail)')
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role="roles/aiplatform.user" --condition=None >/dev/null
echo "Fertig: https://europe-west3-${PROJECT}.cloudfunctions.net/handwritingToText"
