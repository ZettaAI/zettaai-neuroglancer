#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?}" "${REGION:?}" "${REPO:?}" "${STALE_DAYS:?}"
cutoff=$(( $(date +%s) - STALE_DAYS * 86400 ))
found=$(mktemp)
trap 'rm -f "$found"' EXIT

gcloud run services list --project="$PROJECT_ID" --region="$REGION" --format='value(metadata.name)' \
  | sed -nE 's/^neuroglancer-pr-([0-9]+)$/\1/p' \
  | sort -un \
  | while read -r pr; do
      pull=$(gh api "repos/$REPO/pulls/$pr") || {
        echo "::warning::Could not fetch PR #$pr, skipping" >&2
        continue
      }
      if [ "$(jq -r .state <<< "$pull")" != open ]; then
        jq -cn --argjson pr "$pr" '{pr: $pr, reason: "the PR is closed"}' >> "$found"
      elif [ "$(jq -r '.updated_at | fromdateiso8601' <<< "$pull")" -lt "$cutoff" ]; then
        jq -cn --argjson pr "$pr" --arg days "$STALE_DAYS" '{pr: $pr, reason: "the PR had no activity for \($days) days"}' >> "$found"
      fi
    done

jq -sc 'unique_by(.pr)' "$found"
