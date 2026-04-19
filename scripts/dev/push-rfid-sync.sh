#!/usr/bin/env bash
#
# Push RFID sync files to a running U1.
#
# Usage:
#   ./scripts/dev/push-rfid-sync.sh [user@ip]
#
# Default target: root@192.168.2.242
# Requires SSH key auth (run ssh-copy-id root@<ip> first).
# ssh-copy-id root@192.168.2.242
#
# Examples:
#   ./scripts/dev/push-rfid-sync.sh
#   ./scripts/dev/push-rfid-sync.sh root@192.168.2.242
#
# This pushes:
#   1. Expanded OpenRFID webhook templates
#   2. Patched filament_detect.py (applies patch in-place)
#   3. RFID Spools web app (nginx config + HTML + filament_tag.py + klipper cfg)
#   4. Spoolman fields setup script
#   5. NTAG write support injection into fm175xx_reader.py
#
# After push, restarts OpenRFID, Klipper and nginx.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

SSH_HOST="${1:-root@192.168.2.242}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes"

ssh_cmd() {
  ssh $SSH_OPTS "$SSH_HOST" "$@"
}

scp_cmd() {
  scp $SSH_OPTS "$@"
}

echo ">> Target: $SSH_HOST"

# ── 1. Push OpenRFID webhook templates ──
echo ">> Pushing OpenRFID webhook templates..."
OPENRFID_SRC="$REPO_DIR/overlays/firmware-extended/64-app-openrfid/root/usr/local/share/openrfid/extended"
scp_cmd \
  "$OPENRFID_SRC/openrfid_u1_vendor.cfg" \
  "$OPENRFID_SRC/openrfid_u1_generic.cfg" \
  "$SSH_HOST:/usr/local/share/openrfid/extended/"

# ── 1b. Apply OpenRFID TigerTag TD + bed temp patch ──
echo ">> Applying OpenRFID TigerTag TD patch..."
OPENRFID_TD_PATCH="$REPO_DIR/overlays/firmware-extended/64-app-openrfid/patches/usr/local/share/openrfid/03-add-tigertag-td-and-bed-temp.patch"

if ssh_cmd "grep -q 'self.td' /usr/local/share/openrfid/filament/generic.py 2>/dev/null"; then
  echo "   TD patch already applied, skipping."
else
  # Reverse any partial application first
  ssh_cmd "cd /usr/local/share/openrfid && patch -R -p1 --forward < /tmp/openrfid_td.patch 2>/dev/null" || true
  # Strip Windows \r line endings before sending to Linux
  tr -d '\r' < "$OPENRFID_TD_PATCH" | ssh_cmd "cat > /tmp/openrfid_td.patch"
  ssh_cmd "cd /usr/local/share/openrfid && patch -p1 --forward < /tmp/openrfid_td.patch && rm /tmp/openrfid_td.patch"
  echo "   TD patch applied."
fi

# ── 2. Patch filament_detect/set to accept extended fields ──
echo ">> Patching filament_detect/set handler..."
REMOTE_PY="/home/lava/klipper/klippy/extras/filament_detect.py"

# Check if already patched (look for DRYING_TEMP which is new)
if ssh_cmd "grep -q 'DRYING_TEMP' $REMOTE_PY 2>/dev/null"; then
  echo "   Extended fields already present, skipping."
else
  # The printer already has a basic /set handler but without DIAMETER, WEIGHT,
  # DRYING_TEMP, DRYING_TIME, MF_DATE, TD fields.  Inject them just before the
  # "unsupported fields" guard.  We scp a small Python patcher to avoid quoting hell.
  PATCHER=$(mktemp)
  cat > "$PATCHER" << 'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    code = f.read()
marker = "            if params:\n                raise web_request.error"
if marker not in code:
    print("ERROR: cannot find unsupported-fields guard", file=sys.stderr)
    sys.exit(1)
inject = (
    "            if 'DIAMETER' in params:\n"
    "                filament_info['DIAMETER'] = int(params.pop('DIAMETER'))\n"
    "            if 'WEIGHT' in params:\n"
    "                filament_info['WEIGHT'] = int(params.pop('WEIGHT'))\n"
    "            if 'DRYING_TEMP' in params:\n"
    "                filament_info['DRYING_TEMP'] = int(params.pop('DRYING_TEMP'))\n"
    "            if 'DRYING_TIME' in params:\n"
    "                filament_info['DRYING_TIME'] = int(params.pop('DRYING_TIME'))\n"
    "            if 'MF_DATE' in params:\n"
    "                filament_info['MF_DATE'] = str(params.pop('MF_DATE'))\n"
    "            if 'TD' in params:\n"
    "                filament_info['TD'] = float(params.pop('TD'))\n"
    "\n"
)
code = code.replace(marker, inject + marker, 1)
with open(path, 'w') as f:
    f.write(code)
print("Extended fields injected successfully.")
PYEOF
  scp_cmd "$PATCHER" "$SSH_HOST:/tmp/_patch_fd.py"
  rm -f "$PATCHER"
  ssh_cmd "python3 /tmp/_patch_fd.py $REMOTE_PY && rm /tmp/_patch_fd.py"
  echo "   Done."
fi

# ── 3. Push RFID Spools web app ──
echo ">> Pushing RFID Spools web app..."
RFID_SPOOLS_ROOT="$REPO_DIR/overlays/firmware-extended/68-app-rfid-spools/root"

# Push all files from the overlay root tree
tar -cf - -C "$RFID_SPOOLS_ROOT" . |
  ssh_cmd tar -C / -xf -

# Ensure nginx fluidd.d directory exists and reload
ssh_cmd "mkdir -p /etc/nginx/fluidd.d"

# Fix Windows line endings in init script (created on Windows with \r\n)
ssh_cmd "if [ -f /etc/init.d/S98rfid-rw-api ]; then tr -d '\r' < /etc/init.d/S98rfid-rw-api > /tmp/_S98fix && mv /tmp/_S98fix /etc/init.d/S98rfid-rw-api; fi"

# ── 4. Push Spoolman setup script ──
echo ">> Setting permissions..."
ssh_cmd "chmod +x /usr/local/bin/setup-spoolman-fields.sh"
ssh_cmd "chmod +x /usr/local/bin/test-rfid-write.sh" || true
ssh_cmd "chmod +x /usr/local/bin/rfid-rw.py" || true
ssh_cmd "chmod +x /etc/init.d/S98rfid-rw-api" || true

# ── 4b. Activate klipper config in runtime directory ──
echo ">> Activating extended klipper configs..."
ssh_cmd "cp -f /usr/local/share/firmware-config/extended/klipper/05_filament_tag.cfg \
    /oem/printer_data/config/extended/klipper/05_filament_tag.cfg && \
    chown lava:lava /oem/printer_data/config/extended/klipper/05_filament_tag.cfg"
echo "   Done."

# ── 5. Inject NTAG write support into fm175xx_reader.py ──
echo ">> Injecting NTAG write support into fm175xx_reader.py..."
REMOTE_READER="/home/lava/klipper/klippy/extras/fm175xx_reader.py"

# Extract the Python injector from the build script
INJECT_SCRIPT="$REPO_DIR/overlays/firmware-extended/68-app-rfid-spools/scripts/01-add-ntag-write.sh"
sed -n '/^python3 - /,/^PYEOF$/p' "$INJECT_SCRIPT" | \
  sed '1d;$d' | \
  tr -d '\r' | \
  ssh_cmd "cat > /tmp/_inject_ntag_write.py"

if ssh_cmd "grep -q '__reader_a_ntag_page_write' $REMOTE_READER 2>/dev/null"; then
  echo "   Write methods present — checking for v1 bugs..."
  # Fix-up: correct {{}} escaping bug and blocking write_ntag_data
  FIXER=$(mktemp)
  cat > "$FIXER" << 'FIXEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    src = f.read()

changed = False

# Fix 1: {{}} escaping bug (INLINE_CODE was not an f-string)
for old, new in [
    ("_ntag_raw_data = {{}}", "_ntag_raw_data = {}"),
    ("_ntag_write_result = {{'success': True}}", "_ntag_write_result = {'success': True}"),
    ("_ntag_write_result = {{'success': False, 'error': 'page write failed'}}", "_ntag_write_result = {'success': False, 'error': 'page write failed'}"),
]:
    if old in src:
        src = src.replace(old, new)
        changed = True

# Fix 2: Remove blocking time.sleep loop from write_ntag_data
#         (filament_tag.py now polls with reactor.pause instead)
if 'import time as _time' in src:
    lines = src.split('\n')
    start_idx = None
    end_idx = None
    for i, line in enumerate(lines):
        if 'def write_ntag_data(' in line and start_idx is None:
            start_idx = i
        elif start_idx is not None and ('def read_ntag_data(' in line or '# Reader-A' in line):
            end_idx = i
            break

    if start_idx is not None and end_idx is not None:
        defline = lines[start_idx]
        indent = defline[:len(defline) - len(defline.lstrip())]
        new_method = [
            indent + 'def write_ntag_data(self, ch, data, start_page=4, retry_times=3):',
            indent + '    """Queue an NTAG write that executes during the next read cycle."""',
            indent + '    self._pending_ntag_write = {',
            indent + "        'ch': ch, 'data': list(data),",
            indent + "        'start_page': start_page, 'retry_times': retry_times,",
            indent + '    }',
            indent + '    self._ntag_write_result = None',
            indent + '    self.__card_info_read_flag |= (1 << ch)',
            '',
        ]
        lines = lines[:start_idx] + new_method + lines[end_idx:]
        src = '\n'.join(lines)
        changed = True

if changed:
    with open(path, 'w') as f:
        f.write(src)
    print("   Fixed v1 injection bugs.")
else:
    print("   Already up to date.")
FIXEOF
  scp_cmd "$FIXER" "$SSH_HOST:/tmp/_fix_ntag_write.py"
  rm -f "$FIXER"
  ssh_cmd "python3 /tmp/_fix_ntag_write.py $REMOTE_READER && rm /tmp/_fix_ntag_write.py"
else
  # Fresh injection
  ssh_cmd "python3 /tmp/_inject_ntag_write.py $REMOTE_READER"
  echo "   Done."
fi
ssh_cmd "rm -f /tmp/_inject_ntag_write.py"

# ── 6. Restart services ──
echo ">> Restarting rfid-rw API server..."
ssh_cmd "/etc/init.d/S98rfid-rw-api restart" || true

echo ">> Restarting firmware-config (new actions YAML)..."
ssh_cmd "/etc/init.d/S99firmware-config restart" || ssh_cmd "killall -HUP firmware-config.py" || true

echo ">> Restarting Klipper (to load patched filament_detect.py)..."
ssh_cmd "/etc/init.d/S60klipper restart" || true
sleep 2

echo ">> Restarting OpenRFID..."
ssh_cmd "/etc/init.d/S99openrfid restart" || true

echo ">> Reloading nginx..."
ssh_cmd "nginx -t && nginx -s reload" || echo "   nginx reload failed (check config)"

echo ""
echo ">> Done! RFID Spools web app available at:"
echo "   http://${SSH_HOST#*@}/rfid-spools/"
echo ""
echo ">> Enter your Spoolman URL in the web UI config panel."
echo ">> The proxy is dynamic — no server-side config needed."
echo ""
echo ">> To set up Spoolman custom fields, use the button in the"
echo "   web UI or run on the U1:"
echo "   setup-spoolman-fields.sh http://<spoolman-host>:7912"
