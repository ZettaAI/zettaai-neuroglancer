#!/usr/bin/env bash
set -uo pipefail

: "${PR:?}" "${REPO:?}" "${GH_TOKEN:?}"
environment="preview-pr-$PR"
failed=()
ids=$(gh api "repos/$REPO/deployments?environment=$environment&per_page=100" --paginate --jq '.[].id') || {
  echo "::error::Could not list deployments of $environment"
  exit 1
}
for id in $ids; do
  echo "Deleting deployment $id of $environment"
  gh api --method POST "repos/$REPO/deployments/$id/statuses" -f state=inactive >/dev/null \
    && gh api --method DELETE "repos/$REPO/deployments/$id" >/dev/null \
    || failed+=("$id")
done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::Could not delete deployments: ${failed[*]}"
  exit 1
fi
