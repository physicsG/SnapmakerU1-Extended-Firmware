#!/usr/bin/env bash

GIT_URL=https://github.com/physicsG/OpenRFID.git
GIT_SHA=1d8229b307429adbcb73869d55637a61fee2a284

# OpenRFID's TigerTag adapter imports the official SDK package directly.
# Keep both inputs immutable so tag encoding and registry lookups remain
# reproducible across firmware builds.
TIGERTAG_SDK_URL=https://github.com/TigerTag-Project/TigerTag-SDK-Python.git
TIGERTAG_SDK_SHA=f3e2e2e8a1fdf88f91fb43ca4b5c5fbfb88f81af

if [[ -z "$CREATE_FIRMWARE" ]]; then
  echo "Error: This script should be run within the create_firmware.sh environment."
  exit 1
fi

set -eo pipefail

TARGET_DIR="$CACHE_DIR/OpenRFID"
TIGERTAG_SDK_DIR="$CACHE_DIR/TigerTag-SDK-Python"
cache_git.sh "$TARGET_DIR" "$GIT_URL" "$GIT_SHA"
cache_git.sh "$TIGERTAG_SDK_DIR" "$TIGERTAG_SDK_URL" "$TIGERTAG_SDK_SHA"

echo ">> Installing OpenRFID..."
cd "$TARGET_DIR"
make install DESTDIR="$ROOTFS_DIR/usr/local/share/openrfid"

# Install the pure-Python SDK beside OpenRFID. openrfid.py adds this directory
# to sys.path, avoiding an unpinned package resolution in the target image.
install -d "$ROOTFS_DIR/usr/local/share/openrfid/tigertag"
cp -a "$TIGERTAG_SDK_DIR/tigertag/." \
  "$ROOTFS_DIR/usr/local/share/openrfid/tigertag/"
install -m 0644 "$TIGERTAG_SDK_DIR/LICENSE" \
  "$ROOTFS_DIR/usr/local/share/openrfid/TIGERTAG-SDK-LICENSE"
echo ">> OpenRFID installation completed successfully."
