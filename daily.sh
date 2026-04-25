#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

GH_REPO="${GH_REPO:-https://github.com/binary-person/nvidia-driver-database}"
RELEASE_TAG="${GH_RELEASE_TAG:-database}"
RELEASE_TITLE="${GH_RELEASE_TITLE:-Database assets}"
CHANGE_STATUS_FILE="data/.daily-change-status"
MASTER_DATABASE_GZIP_FILE="data/nvidia-driver-database.sqlite.gz"
RAW_PAYLOAD_ARCHIVE_FILE="data/data-raw.tar.gz"

ASSETS=(
  "data/browser.sqlite"
  "data/browser.sqlite.gz"
  "data/browser.sqlite.meta.json"
  "$MASTER_DATABASE_GZIP_FILE"
  "$RAW_PAYLOAD_ARCHIVE_FILE"
)

GH_REPO_ARGS=()
if [[ -n "${GH_REPO:-}" ]]; then
  GH_REPO_ARGS=(--repo "$GH_REPO")
fi

echo "crawling master database"
node app.js --concurrency 2 --write-change-status "$CHANGE_STATUS_FILE"

if [[ ! -f "$CHANGE_STATUS_FILE" ]]; then
  echo "missing change status file: $CHANGE_STATUS_FILE" >&2
  exit 1
fi

CHANGE_STATUS="$(tr -d '[:space:]' < "$CHANGE_STATUS_FILE")"
if [[ "$CHANGE_STATUS" != "0" && "$CHANGE_STATUS" != "1" ]]; then
  echo "unexpected change status value: $CHANGE_STATUS" >&2
  exit 1
fi

if [[ "$CHANGE_STATUS" == "0" ]]; then
  echo "master sqlite content unchanged; skipping browser build and release upload"
  exit 0
fi

echo "building browser database"
node app.js buildbrowserdb

echo "compressing master database"
gzip -9 -c "data/nvidia-driver-database.sqlite" > "${MASTER_DATABASE_GZIP_FILE}.tmp"
mv -f "${MASTER_DATABASE_GZIP_FILE}.tmp" "$MASTER_DATABASE_GZIP_FILE"

if [[ ! -d "data-raw" ]]; then
  echo "missing directory: data-raw" >&2
  exit 1
fi

echo "archiving data-raw"
tar -cf - "data-raw" | gzip -9 > "${RAW_PAYLOAD_ARCHIVE_FILE}.tmp"
mv -f "${RAW_PAYLOAD_ARCHIVE_FILE}.tmp" "$RAW_PAYLOAD_ARCHIVE_FILE"

for asset in "${ASSETS[@]}"; do
  if [[ ! -f "$asset" ]]; then
    echo "missing asset: $asset" >&2
    exit 1
  fi
done

if ! gh release view "$RELEASE_TAG" "${GH_REPO_ARGS[@]}" >/dev/null 2>&1; then
  echo "creating release $RELEASE_TAG"
  gh release create "$RELEASE_TAG" "${GH_REPO_ARGS[@]}" --title "$RELEASE_TITLE" --notes ""
fi

echo "uploading release assets"
gh release upload "$RELEASE_TAG" "${ASSETS[@]}" --clobber "${GH_REPO_ARGS[@]}"
