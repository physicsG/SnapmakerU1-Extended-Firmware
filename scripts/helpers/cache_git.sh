#!/usr/bin/env bash

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <target-dir> <git-url> <git-rev>"
  exit 1
fi

TARGET_DIR="$1"
GIT_URL="$2"
GIT_SHA="$3"

set -e

if [[ ! -d "$TARGET_DIR" ]]; then
  echo ">> Cloning $GIT_URL into $TARGET_DIR"
  git clone "$GIT_URL" "$TARGET_DIR" --recursive
elif [[ -n "$CI" ]]; then
  echo ">> CI environment detected. Forcing the git repository to be re-fetched."
else
  # The cache exists. Only reuse it as-is when HEAD already matches the
  # requested SHA — otherwise a stale checkout silently shadows a bumped
  # GIT_SHA and the resulting firmware ships with old code (see the
  # OpenRFID overlay reinstall problem). Resolve and compare full SHAs.
  REQUESTED_SHA=$(git -C "$TARGET_DIR" rev-parse --verify "$GIT_SHA^{commit}" 2>/dev/null || true)
  CURRENT_SHA=$(git -C "$TARGET_DIR" rev-parse --verify HEAD 2>/dev/null || true)
  if [[ -n "$REQUESTED_SHA" && "$REQUESTED_SHA" == "$CURRENT_SHA" ]]; then
    echo ">> Using cached git repository in $TARGET_DIR (HEAD matches $GIT_SHA)"
    exit 0
  fi
  echo ">> Cached $TARGET_DIR is at ${CURRENT_SHA:-unknown} but $GIT_SHA was requested; refreshing."
fi

echo ">> Fetching $GIT_SHA into $TARGET_DIR"
if ! git -C "$TARGET_DIR" checkout -f "$GIT_SHA"; then
  git -C "$TARGET_DIR" remote set-url origin "$GIT_URL" || git -C "$TARGET_DIR" remote add origin "$GIT_URL"
  git -C "$TARGET_DIR" fetch origin "$GIT_SHA"
  git -C "$TARGET_DIR" checkout -f "$GIT_SHA"
fi

git -C "$TARGET_DIR" submodule update --init --recursive --checkout --force

