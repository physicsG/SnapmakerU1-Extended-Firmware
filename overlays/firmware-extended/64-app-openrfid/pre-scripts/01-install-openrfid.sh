#!/usr/bin/env bash

GIT_URL=https://github.com/physicsG/OpenRFID.git
# Pinned to the fork that adds the openrfid_api Moonraker controller,
# openrfid_agent_event_exporter, Fm175xx.write_ntag_pages, runtime
# pending-write queue, and the upstream tigertag encoder/processor
# changes. Bump back to suchmememanyskill/OpenRFID once the PR merges.
GIT_SHA=227312c72564454b4106b257b5593e181dfa28c3

if [[ -z "$CREATE_FIRMWARE" ]]; then
  echo "Error: This script should be run within the create_firmware.sh environment."
  exit 1
fi

set -eo pipefail

TARGET_DIR="$CACHE_DIR/OpenRFID"
cache_git.sh "$TARGET_DIR" "$GIT_URL" "$GIT_SHA"

echo ">> Installing OpenRFID..."
cd "$TARGET_DIR"
make install DESTDIR="$ROOTFS_DIR/usr/local/share/openrfid"
echo ">> OpenRFID installation completed successfully."
