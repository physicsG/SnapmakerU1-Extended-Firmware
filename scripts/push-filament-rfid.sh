#!/usr/bin/env bash
#
# Push the current filament RFID write UI/OpenRFID overlay files to a printer.
#
# Usage:
#   ./scripts/push-filament-rfid.sh root@<printer-ip>
#   ./scripts/push-filament-rfid.sh <printer-ip>
#
# SSH key setup (avoids password prompts):
#   1. Generate a key (if you don't have one):
#        ssh-keygen -t ed25519
#   2. Copy it to the printer:
#        ssh-copy-id -o StrictHostKeyChecking=no root@192.168.2.242
#      (default password: snapmaker)
#   3. Verify passwordless login:
#        ssh root@192.168.2.242 echo ok
#

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <user@host>"
    echo "Example: $0 root@192.168.2.242"
    exit 1
fi

HOST="$1"
if [[ "$HOST" != *@* ]]; then
    HOST="root@$HOST"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

FILAMENT_UI_ROOT="$REPO_ROOT/overlays/firmware-extended/68-app-filament-ui/root"
OPENRFID_ROOT="$REPO_ROOT/overlays/firmware-extended/64-app-openrfid/root"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

TMPDIR="$(mktemp -d)"
ARCHIVE="$(mktemp /tmp/filament-rfid-push-XXXXXX.tar.gz)"
trap 'rm -rf "$TMPDIR" "$ARCHIVE"' EXIT

echo ">> Packing filament UI and OpenRFID overlay files (stripping CRLF)..."
cp -a "$FILAMENT_UI_ROOT"/. "$TMPDIR"/
cp -a "$OPENRFID_ROOT"/. "$TMPDIR"/

find "$TMPDIR" -type f \( \
    -name '*.sh' -o -name '*.py' -o -name '*.conf' -o -name '*.cfg' \
    -o -name '*.yaml' -o -name 'S99*' \
    -o -name '*.html' -o -name '*.js' -o -name '*.css' \
    \) -exec sed -i 's/\r$//' {} +

tar -czf "$ARCHIVE" -C "$TMPDIR" .

echo ">> Uploading to $HOST..."
scp "${SSH_OPTS[@]}" "$ARCHIVE" "$HOST:/tmp/filament-rfid-push.tar.gz"

echo ">> Deploying on $HOST..."
ssh "${SSH_OPTS[@]}" "$HOST" '
  set -e

  rm -rf /usr/local/filament-ui/html
  tar -C / -xzf /tmp/filament-rfid-push.tar.gz
  rm -f /tmp/filament-rfid-push.tar.gz

  chmod -R a+rX \
    /usr/local/filament-ui/html \
    /usr/local/share/openrfid/extended \
    /usr/local/share/firmware-config/functions
  chmod 755 /etc/init.d/S99openrfid /usr/local/bin/openrfid.py

  # Clear Python bytecode caches for modified OpenRFID launcher/config glue.
  find /usr/local/share/openrfid -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
  find /usr/local/bin -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

  /etc/init.d/S99openrfid restart
  nginx -s reload
'

echo ">> Deployed filament UI files:"
ssh "${SSH_OPTS[@]}" "$HOST" "find /usr/local/filament-ui/html/ -type f | sort"

echo ">> Done. Access at http://${HOST#*@}/filament/"
