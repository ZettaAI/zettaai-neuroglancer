#!/usr/bin/env bash
set -uo pipefail

: "${PR:?}" "${PROJECT_ID:?}" "${REGION:?}" "${IMAGE:?}"
service="neuroglancer-pr-$PR"
failed=()

existing=$(gcloud run services list --project="$PROJECT_ID" --region="$REGION" \
  --filter="metadata.name=$service" --format='value(metadata.name)') || {
  echo "::error::Could not list Cloud Run services"
  exit 1
}
if [ -n "$existing" ]; then
  gcloud run services delete "$service" --project="$PROJECT_ID" --region="$REGION" --quiet \
    || failed+=("$service")
else
  echo "$service does not exist, nothing to delete"
fi

tags=$(gcloud artifacts docker tags list "$IMAGE" --format='value(tag)') || {
  echo "::error::Could not list tags of $IMAGE"
  exit 1
}
for tag in $(sed 's|.*/tags/||' <<< "$tags" | { grep -E -- "^([0-9a-f]{40}-$service|cache-$service)\$" || true; }); do
  echo "Deleting $IMAGE:$tag"
  gcloud artifacts docker tags delete "$IMAGE:$tag" --quiet || failed+=("$tag")
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::Could not delete: ${failed[*]}"
  exit 1
fi
