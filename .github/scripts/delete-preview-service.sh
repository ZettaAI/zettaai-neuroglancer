#!/usr/bin/env bash
set -euo pipefail

: "${PR:?}" "${PROJECT_ID:?}" "${REGION:?}" "${IMAGE:?}"
service="neuroglancer-pr-$PR"

existing=$(gcloud run services list --project="$PROJECT_ID" --region="$REGION" \
  --filter="metadata.name=$service" --format='value(metadata.name)')
if [ -n "$existing" ]; then
  gcloud run services delete "$service" --project="$PROJECT_ID" --region="$REGION" --quiet
else
  echo "$service does not exist, nothing to delete"
fi

gcloud artifacts docker tags list "$IMAGE" --format='value(tag)' \
  | sed 's|.*/tags/||' \
  | { grep -E -- "^([0-9a-f]{40}-$service|cache-$service)\$" || true; } \
  | while read -r tag; do
      echo "Deleting $IMAGE:$tag"
      gcloud artifacts docker tags delete "$IMAGE:$tag" --quiet
    done
