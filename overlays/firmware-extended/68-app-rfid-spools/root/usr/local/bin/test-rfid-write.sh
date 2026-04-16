#!/bin/sh
# ──────────────────────────────────────────────────────────────
# test-rfid-write.sh — Test NTAG read/write via direct SPI
#
# Uses rfid-rw.py which talks to the FM175xx chip directly,
# temporarily stopping OpenRFID for SPI access.
#
# Usage:
#   test-rfid-write.sh [CHANNEL] [ACTION] [HEX_DATA]
#
# Actions:
#   read     — read TigerTag user data + decode fields (default)
#   write    — write test pattern (DEADBEEF), then verify
#   writeraw — write supplied hex data (192 hex chars = 96 bytes)
#   restore  — write back previously saved data (from last read)
#   dump     — full hex dump of pages 0-33
#   status   — show OpenRFID/Klipper RFID status
#
# Examples:
#   test-rfid-write.sh            # read channel 0
#   test-rfid-write.sh 0 read    # read channel 0
#   test-rfid-write.sh 0 write   # write test pattern to channel 0
#   test-rfid-write.sh 1 dump    # dump raw tag data on channel 1
#   test-rfid-write.sh 0 restore # restore last-read data
#   test-rfid-write.sh 0 writeraw AABB...  # write specific hex data
# ──────────────────────────────────────────────────────────────
set -e

RFID_RW="/usr/local/bin/rfid-rw.py"
CH="${1:-0}"
ACTION="${2:-read}"
SAVE_FILE="/tmp/rfid_backup_ch${CH}.hex"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()  { printf "${CYAN}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
err()   { printf "${RED}[err]${NC}   %s\n" "$*" >&2; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }

# ── Check rfid-rw.py exists ──────────────────────────────────
if [ ! -f "$RFID_RW" ]; then
    err "rfid-rw.py not found at ${RFID_RW}"
    exit 1
fi

# ══════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════

printf "\n${BOLD}═══ RFID Tag Test — Channel %s ═══${NC}\n\n" "$CH"

case "$ACTION" in
    read)
        info "Reading tag on channel ${CH} (direct SPI)..."
        python3 "$RFID_RW" read "$CH"
        ;;

    dump)
        info "Dumping tag on channel ${CH} (direct SPI)..."
        python3 "$RFID_RW" dump "$CH"
        ;;

    write)
        info "── WRITE TEST ──"

        # Step 1: Read current data and save backup
        info "Step 1/3: Reading current tag data..."
        python3 "$RFID_RW" read "$CH" || true

        if [ -f "$SAVE_FILE" ]; then
            ORIG_HEX=$(cat "$SAVE_FILE")
            ok "Backup at ${SAVE_FILE} (${#ORIG_HEX} hex chars)"
        else
            warn "No backup created (no tag data?)"
            ORIG_HEX=""
        fi

        # Step 2: Build test payload — stamp DEADBEEF in last 4 bytes
        info "Step 2/3: Building test payload..."
        if [ -n "$ORIG_HEX" ] && [ ${#ORIG_HEX} -ge 192 ]; then
            # Replace last 8 hex chars (4 bytes) with DEADBEEF
            MODIFIED="${ORIG_HEX%????????}DEADBEEF"
            info "  Stamping DEADBEEF at end of user data"
        else
            # Minimal 96-byte pattern
            MODIFIED="5bf5926400000000ffff0000008e38ffff000000ff000000001500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000DEADBEEF"
            warn "No existing tag data — using minimal test payload"
        fi

        # Step 3: Write + verify (rfid-rw.py does read-back verify)
        info "Step 3/3: Writing to tag..."
        python3 "$RFID_RW" write "$CH" "$MODIFIED"
        RC=$?

        if [ $RC -eq 0 ]; then
            printf "\n  ${GREEN}WRITE TEST PASSED${NC}\n"
        else
            printf "\n  ${RED}WRITE TEST FAILED${NC}\n"
        fi

        info ""
        info "To restore original data, run:"
        info "  test-rfid-write.sh ${CH} restore"
        ;;

    writeraw)
        HEX_DATA="${3:-}"
        if [ -z "$HEX_DATA" ] || [ ${#HEX_DATA} -ne 192 ]; then
            err "writeraw requires exactly 192 hex chars (96 bytes)"
            err "Got: ${#HEX_DATA} chars"
            exit 1
        fi
        info "Writing supplied data to channel ${CH}..."
        python3 "$RFID_RW" write "$CH" "$HEX_DATA"
        ;;

    restore)
        if [ ! -f "$SAVE_FILE" ]; then
            err "No backup found at ${SAVE_FILE}"
            err "Run 'test-rfid-write.sh ${CH} read' first to save current data"
            exit 1
        fi

        ORIG_HEX=$(cat "$SAVE_FILE")
        if [ -z "$ORIG_HEX" ] || [ ${#ORIG_HEX} -lt 192 ]; then
            err "Backup file too small or empty (${#ORIG_HEX} hex chars, need 192)"
            exit 1
        fi

        info "Restoring ${#ORIG_HEX} hex chars from backup..."
        python3 "$RFID_RW" write "$CH" "$ORIG_HEX"
        RC=$?

        if [ $RC -eq 0 ]; then
            ok "Restore complete + verified"
        else
            err "Restore failed"
        fi
        ;;

    status)
        MOONRAKER="http://127.0.0.1:7125"
        info "Checking OpenRFID status..."
        if pidof python3 >/dev/null 2>&1; then
            PID=$(pidof python3 | tr ' ' '\n' | head -1)
            CMD=$(cat /proc/$PID/cmdline 2>/dev/null | tr '\0' ' ')
            ok "python3 running: PID $PID — $CMD"
        else
            warn "No python3 processes found"
        fi

        # Check init scripts
        for s in /etc/init.d/S59rfid-support /etc/init.d/S60openrfid; do
            if [ -f "$s" ]; then
                info "Found: $s"
            fi
        done

        # Check Moonraker filament_detect
        info "Querying Moonraker filament_detect..."
        RESULT=$(wget -qO- "${MOONRAKER}/printer/objects/query?filament_detect" 2>/dev/null || echo "")
        if [ -n "$RESULT" ]; then
            echo "$RESULT" | sed 's/,/,\n  /g; s/{/{\n  /g; s/}/\n}/g'
        else
            warn "No response from Moonraker"
        fi

        # Check syslog for openrfid
        info ""
        info "Recent OpenRFID syslog entries:"
        logread 2>/dev/null | grep -i "openrfid\|rfid" | tail -10 || warn "No entries found"

        # Check klippy log
        info ""
        info "Recent RFID klipper log entries:"
        grep -i "filament_tag\|filament_detect\|rfid\|fm175" /oem/printer_data/logs/klippy.log 2>/dev/null | tail -10 || warn "No entries found"
        ;;

    *)
        err "Unknown action: ${ACTION}"
        echo "Usage: test-rfid-write.sh [CHANNEL] [ACTION] [HEX_DATA]"
        echo "Actions: read, write, writeraw, restore, dump, status"
        exit 1
        ;;
esac

printf "\n${BOLD}═══ Done ═══${NC}\n\n"
