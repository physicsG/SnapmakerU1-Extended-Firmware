#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Inject NTAG page-write support into Klipper's fm175xx_reader.py
#
# This script runs AFTER all patches from earlier overlays
# (including 13-patch-rfid which adds NTAG read support).
# It adds:
#   1. Low-level __reader_a_ntag_page_write()
#   2. Multi-page __reader_a_ntag_write_user_data()
#   3. Public write_ntag_data() — queues write during next read cycle
#   4. Public read_ntag_data()  — returns stored raw bytes
#   5. Inline injection: stores raw NTAG data + checks pending writes
#      inside the existing NTAG read-success block
# ──────────────────────────────────────────────────────────────
set -euo pipefail

ROOTFS="$1"
READER="$ROOTFS/home/lava/klipper/klippy/extras/fm175xx_reader.py"

if [ ! -f "$READER" ]; then
    echo "ERROR: fm175xx_reader.py not found at $READER"
    exit 1
fi

python3 - "$READER" << 'PYEOF'
import sys, re, textwrap

path = sys.argv[1]
with open(path, 'r') as f:
    src = f.read()

# ── Guard: skip if already injected ──────────────────────────
if '__reader_a_ntag_page_write' in src:
    print("[rfid-spools] NTAG write support already present, skipping")
    sys.exit(0)

# ── 1. Inject low-level write methods ────────────────────────
#    Insert before "# Reader-A: M1, read all data"
WRITE_METHODS = textwrap.dedent("""\
    # ── NTAG page write (injected by rfid-spools) ─────────────
    def __reader_a_ntag_page_write(self, page, data):
        outbuf = [0] * 6
        inbuf  = [0] * 1
        cmd = Fm175xxCmdMetaData()
        ret = Fm175xxReturnVal()

        cmd.send_crc_en  = FM175XX_SET
        cmd.recv_crc_en  = FM175XX_RESET
        cmd.send_buff    = outbuf
        cmd.recv_buff    = inbuf
        cmd.send_buff[0] = 0xA2          # NTAG WRITE command
        cmd.send_buff[1] = page & 0xFF
        for i in range(4):
            cmd.send_buff[2 + i] = data[i] & 0xFF
        cmd.bytes_to_send = 6
        cmd.bits_to_send  = 0
        cmd.bits_to_recv  = 0
        cmd.bytes_to_recv = 1
        cmd.timeout       = 10
        cmd.cmd           = FM175XX_CMD_TRANSCEIVE
        result = self.__command_exe(cmd)
        ret.err_code = result.err_code

        if FM175XX_OK == result.err_code:
            # ACK is 4-bit 0x0A; the nibble sits in recv_buff[0]
            if (result.out_param.recv_buff[0] & 0x0F) != 0x0A:
                ret.err_code = FM175XX_CARD_COMM_ERR

        return ret

    def __reader_a_ntag_write_user_data(self, data, start_page=4, retry_times=3):
        ret = Fm175xxReturnVal()
        pages = (len(data) + FM175XX_NTAG215_BYTES_PER_PAGE - 1) // FM175XX_NTAG215_BYTES_PER_PAGE

        for i in range(pages):
            page   = start_page + i
            offset = i * FM175XX_NTAG215_BYTES_PER_PAGE
            pdata  = list(data[offset:offset + FM175XX_NTAG215_BYTES_PER_PAGE])
            while len(pdata) < FM175XX_NTAG215_BYTES_PER_PAGE:
                pdata.append(0)

            result = Fm175xxReturnVal()
            for _attempt in range(retry_times):
                result = self.__reader_a_ntag_page_write(page, pdata)
                if result.err_code == FM175XX_OK:
                    break
            if result.err_code != FM175XX_OK:
                logging.error("NTAG write failed at page %d after %d retries", page, retry_times)
                ret.err_code = FM175XX_CARD_COMM_ERR
                return ret

        ret.err_code = FM175XX_OK
        return ret

    def write_ntag_data(self, ch, data, start_page=4, retry_times=3):
        \"\"\"Queue an NTAG write that executes during the next read cycle.

        The read thread activates the card (wakeup / anticoll / select)
        as part of its normal flow.  We piggy-back on that activation so
        the card is guaranteed to be in the correct state for writing.

        The caller (filament_tag.py) polls _ntag_write_result using
        reactor.pause() which properly yields the Klipper reactor.
        \"\"\"
        self._pending_ntag_write = {
            'ch': ch, 'data': list(data),
            'start_page': start_page, 'retry_times': retry_times,
        }
        self._ntag_write_result = None
        # Trigger a read cycle for this channel
        self.__card_info_read_flag |= (1 << ch)

    def read_ntag_data(self, ch):
        \"\"\"Return the raw NTAG bytes captured during the last read cycle.\"\"\"
        raw = getattr(self, '_ntag_raw_data', {})
        if ch not in raw:
            raise Exception("No raw NTAG data for channel %d (re-read first)" % ch)
        return list(raw[ch])

""")

MARKER_METHODS = "    # Reader-A: M1, read all data"
if MARKER_METHODS not in src:
    print("ERROR: could not find methods insertion marker in fm175xx_reader.py")
    sys.exit(1)

src = src.replace(MARKER_METHODS, WRITE_METHODS + MARKER_METHODS)
print("[rfid-spools] Injected NTAG write methods")

# ── 2. Inject inline code in the NTAG-read-success block ─────
#    Find the unique sequence added by patch 01:
#        card_data = ret.out_param[0:FM175XX_NTAG215_TOTAL_SIZE]
#        card_op_result = FM175XX_OK
#    Insert our raw-data storage + pending-write check right after.

MARKER_READ_OK = "card_data = ret.out_param[0:FM175XX_NTAG215_TOTAL_SIZE]"
if MARKER_READ_OK not in src:
    print("ERROR: could not find NTAG read-success marker")
    sys.exit(1)

# Determine the indentation of the marker line
for line in src.splitlines():
    stripped = line.lstrip()
    if stripped.startswith("card_data = ret.out_param[0:FM175XX_NTAG215_TOTAL_SIZE]"):
        indent = line[: len(line) - len(stripped)]
        break
else:
    print("ERROR: indentation detection failed")
    sys.exit(1)

# The block we inject right after "card_op_result = FM175XX_OK"
INLINE_CODE = (
    "\n"
    "{I}# ── Store raw NTAG data + pending write (injected) ──\n"
    "{I}if not hasattr(self, '_ntag_raw_data'):\n"
    "{I}    self._ntag_raw_data = {}\n"
    "{I}self._ntag_raw_data[ch] = list(card_data)\n"
    "\n"
    "{I}if getattr(self, '_pending_ntag_write', None):\n"
    "{I}    _pw = self._pending_ntag_write\n"
    "{I}    if _pw.get('ch') == ch:\n"
    "{I}        self._pending_ntag_write = None\n"
    "{I}        _wr = self.__reader_a_ntag_write_user_data(\n"
    "{I}            _pw['data'], _pw.get('start_page', 4), _pw.get('retry_times', 3))\n"
    "{I}        if _wr.err_code == FM175XX_OK:\n"
    "{I}            logging.info('NTAG write OK on ch %d', ch)\n"
    "{I}            self._ntag_write_result = {'success': True}\n"
    "{I}        else:\n"
    "{I}            logging.error('NTAG write FAILED on ch %d', ch)\n"
    "{I}            self._ntag_write_result = {'success': False, 'error': 'page write failed'}\n"
).replace("{I}", indent)

# Find the "card_op_result = FM175XX_OK" line that immediately follows the marker
old_block = (
    f"{indent}card_data = ret.out_param[0:FM175XX_NTAG215_TOTAL_SIZE]\n"
    f"{indent}card_op_result = FM175XX_OK\n"
)
new_block = old_block + INLINE_CODE

if old_block not in src:
    # Try with extra whitespace / CRLF
    old_block_cr = old_block.replace("\n", "\r\n")
    if old_block_cr in src:
        src = src.replace(old_block_cr, new_block.replace("\n", "\r\n"), 1)
    else:
        print("WARNING: could not inject inline write check (block not found)")
        print("         Tag writing will still work via write_ntag_data() but")
        print("         will not be able to piggy-back on the read cycle.")
else:
    src = src.replace(old_block, new_block, 1)

print("[rfid-spools] Injected inline NTAG write check")

# ── Write out ─────────────────────────────────────────────────
with open(path, 'w') as f:
    f.write(src)

print("[rfid-spools] fm175xx_reader.py updated successfully")
PYEOF
