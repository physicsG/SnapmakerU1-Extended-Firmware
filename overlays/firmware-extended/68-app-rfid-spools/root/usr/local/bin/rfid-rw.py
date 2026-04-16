#!/usr/bin/env python3
"""
rfid-rw.py — Standalone NTAG read/write via direct SPI to FM175xx.

Bypasses OpenRFID/Klipper by talking to the FM175xx chip directly.
OpenRFID is stopped before SPI access and restarted after.

Usage:
    rfid-rw.py read   CHANNEL              Read 96 bytes of TigerTag user data
    rfid-rw.py write  CHANNEL HEX_DATA     Write 96 bytes (192 hex chars) to user area
    rfid-rw.py dump   CHANNEL              Full hex dump of pages 0-33
    rfid-rw.py decode CHANNEL              Read + decode TigerTag fields
    rfid-rw.py serve  [PORT]               Start HTTP API server (default: 8739)

CHANNEL: 0-3 (slot number)
"""
import sys
import os
import time
import struct
import subprocess
import signal
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

# ── FM175xx Register Addresses ────────────────────────────────
COMMAND_REG      = 0x01
COM_I_EN_REG     = 0x02
DIV_I_EN_REG     = 0x03
COM_IRQ_REG      = 0x04
DIV_IRQ_REG      = 0x05
ERROR_REG        = 0x06
STATUS_2_REG     = 0x08
FIFO_DATA_REG    = 0x09
FIFO_LEVEL_REG   = 0x0A
WATER_LEVEL_REG  = 0x0B
CONTROL_REG      = 0x0C
BIT_FRAMING_REG  = 0x0D
COLL_REG         = 0x0E
TX_MODE_REG      = 0x12
RX_MODE_REG      = 0x13
TX_CONTROL_REG   = 0x14
TX_AUTO_REG      = 0x15
RX_THRESHOLD_REG = 0x18
MODE_WIDTH_REG   = 0x24
RF_CFG_REG       = 0x26
GSN_ON_REG       = 0x27
CW_GSP_REG       = 0x28
T_MODE_REG       = 0x2A
T_PRESCALER_REG  = 0x2B
T_RELOAD_MSB_REG = 0x2C
T_RELOAD_LSB_REG = 0x2D
VERSION_REG      = 0x37

# Commands
CMD_IDLE         = 0x00
CMD_TRANSCEIVE   = 0x0C

# Error codes
OK               = 0
TIMER_ERR        = -20
COMM_ERR         = -22

# Channel layout: (spi_bus, spi_dev, rst_gpio_line, coil27_state, coil24_state)
# gpio lines are on gpiochip1
CHANNELS = {
    0: {'bus': 2, 'dev': 1, 'rst': 28, 'gpio27': 1, 'gpio24': 0},  # left, upper coil
    1: {'bus': 2, 'dev': 1, 'rst': 28, 'gpio27': 0, 'gpio24': 1},  # left, lower coil
    2: {'bus': 2, 'dev': 0, 'rst': 25, 'gpio27': 1, 'gpio24': 0},  # right, upper coil
    3: {'bus': 2, 'dev': 0, 'rst': 25, 'gpio27': 0, 'gpio24': 1},  # right, lower coil
}

# TigerTag constants
TT_MAGIC         = 0x5BF59264
TT_USER_START    = 4   # page 4
TT_USER_PAGES    = 24  # pages 4-27, 96 bytes


class FM175xx:
    """Low-level FM175xx SPI driver."""

    def __init__(self, bus, dev):
        import spidev
        self.spi = spidev.SpiDev()
        self.spi.open(bus, dev)
        self.spi.max_speed_hz = 500000
        self.spi.mode = 0

    def close(self):
        self.spi.close()

    def reg_read(self, addr):
        r = self.spi.xfer([(addr << 1) | 0x80, 0x00])
        return r[1]

    def reg_write(self, addr, val):
        self.spi.xfer([(addr << 1) & 0x7E, val])

    def reg_modify(self, addr, mask, is_set):
        val = self.reg_read(addr)
        if is_set:
            val |= mask
        else:
            val &= ~mask & 0xFF
        self.reg_write(addr, val)

    def fifo_read(self, n):
        r = self.spi.xfer([0x92] * n + [0x00])
        return r[1:n + 1]

    def fifo_write(self, data):
        self.spi.xfer([0x12] + list(data))

    def set_timeout(self, timeout_ms):
        # Timer prescaler 3390 → ~1ms per timer tick
        self.reg_write(T_MODE_REG, 0x80 | ((3390 >> 8) & 0x0F))
        self.reg_write(T_PRESCALER_REG, 3390 & 0xFF)
        self.reg_write(T_RELOAD_MSB_REG, (timeout_ms >> 8) & 0xFF)
        self.reg_write(T_RELOAD_LSB_REG, timeout_ms & 0xFF)

    def set_crc(self, tx_en, rx_en):
        if tx_en:
            self.reg_modify(TX_MODE_REG, 0x80, 1)
        else:
            self.reg_modify(TX_MODE_REG, 0x80, 0)
        if rx_en:
            self.reg_modify(RX_MODE_REG, 0x80, 1)
        else:
            self.reg_modify(RX_MODE_REG, 0x80, 0)

    def transceive(self, send_buf, bytes_to_recv, tx_crc=True, rx_crc=True,
                   bits_to_send=0, bits_to_recv=0, timeout=10):
        """Send data and receive response. Returns (err_code, data, bits_recved)."""
        # Reset
        self.reg_write(COMMAND_REG, CMD_IDLE)
        self.reg_write(FIFO_LEVEL_REG, 0x80)  # flush FIFO
        self.reg_write(COM_IRQ_REG, 0x7F)
        self.reg_write(DIV_IRQ_REG, 0x7F)
        self.reg_write(COM_I_EN_REG, 0x80)
        self.reg_write(DIV_I_EN_REG, 0x00)
        self.reg_write(WATER_LEVEL_REG, 32)

        self.set_crc(tx_crc, rx_crc)
        self.set_timeout(timeout)

        # Start transceive
        self.reg_write(COMMAND_REG, CMD_TRANSCEIVE)
        self.reg_write(BIT_FRAMING_REG, (bits_to_recv << 4) | bits_to_send)

        # Write data to FIFO and start TX
        send_data = list(send_buf)
        fifo_wl = 32
        send_finish = False

        t0 = time.time()
        deadline = t0 + 0.05 + timeout / 1000.0
        recv_buf = []
        result = TIMER_ERR

        while time.time() < deadline:
            irq = self.reg_read(COM_IRQ_REG)

            if irq & 0x01:  # timer
                result = TIMER_ERR
                break

            if irq & 0x02:  # error
                err = self.reg_read(ERROR_REG)
                result = COMM_ERR
                break

            if irq & 0x04:  # low alert — send more
                if send_data:
                    chunk = send_data[:fifo_wl]
                    send_data = send_data[fifo_wl:]
                    self.fifo_write(chunk)
                    self.reg_modify(BIT_FRAMING_REG, 0x80, 1)  # start send
                self.reg_write(COM_IRQ_REG, 0x04)

            if irq & 0x08:  # high alert — recv data ready
                if send_finish:
                    recv_buf.extend(self.fifo_read(fifo_wl))
                self.reg_write(COM_IRQ_REG, 0x08)

            if irq & 0x20:  # RX complete
                bits_r = self.reg_read(CONTROL_REG) & 0x07
                n = self.reg_read(FIFO_LEVEL_REG) & 0x7F
                recv_buf.extend(self.fifo_read(n))
                result = OK
                break

            if irq & 0x40:  # TX complete
                send_finish = True
                # If we still have data, keep sending in next low-alert
                if not send_data:
                    pass
                self.reg_write(COM_IRQ_REG, 0x40)

        self.reg_modify(BIT_FRAMING_REG, 0x80, 0)
        self.reg_write(COMMAND_REG, CMD_IDLE)

        bits_r = 0
        if result == OK:
            bits_r = self.reg_read(CONTROL_REG) & 0x07

        return result, recv_buf, bits_r

    def init_type_a(self):
        """Initialize for ISO14443A (NTAG, Mifare)."""
        self.reg_write(TX_MODE_REG, 0x00)
        self.reg_write(RX_MODE_REG, 0x08)
        self.reg_modify(TX_AUTO_REG, 0x40, 1)     # Force100ASK
        self.reg_write(MODE_WIDTH_REG, 0x26)
        self.reg_write(CONTROL_REG, 0x10)
        self.reg_write(GSN_ON_REG, 0xF0)
        self.reg_write(CW_GSP_REG, 0x3F)
        self.reg_write(RF_CFG_REG, 0x60)           # 48dB gain
        self.reg_write(RX_THRESHOLD_REG, 0x84)
        self.reg_modify(STATUS_2_REG, 0x08, 0)     # Clear MFCrypto1On

    def carrier_on(self):
        self.reg_modify(TX_CONTROL_REG, 0x03, 1)

    def carrier_off(self):
        self.reg_modify(TX_CONTROL_REG, 0x03, 0)

    def wakeup(self):
        """WUPA — returns (err, ATQA_2bytes)."""
        err, data, _ = self.transceive([0x52], 2,
                                        tx_crc=False, rx_crc=False,
                                        bits_to_send=7, timeout=10)
        if err == OK and len(data) == 2:
            return OK, data
        # Fallback: REQA
        err, data, _ = self.transceive([0x26], 2,
                                        tx_crc=False, rx_crc=False,
                                        bits_to_send=7, timeout=10)
        if err == OK and len(data) == 2:
            return OK, data
        return err or COMM_ERR, []

    def anticoll(self, level):
        """Anticollision for cascade level 0/1/2. Returns (err, uid4, bcc)."""
        cmd_byte = [0x93, 0x95, 0x97][level]
        err, data, _ = self.transceive([cmd_byte, 0x20], 5,
                                        tx_crc=False, rx_crc=False, timeout=10)
        if err != OK or len(data) != 5:
            return err or COMM_ERR, [], 0
        uid = data[:4]
        bcc = data[4]
        check = uid[0] ^ uid[1] ^ uid[2] ^ uid[3] ^ bcc
        if check != 0:
            return COMM_ERR, [], 0
        return OK, uid, bcc

    def select(self, level, uid4, bcc):
        """Select card at cascade level. Returns (err, SAK)."""
        cmd_byte = [0x93, 0x95, 0x97][level]
        err, data, _ = self.transceive([cmd_byte, 0x70] + uid4 + [bcc], 1,
                                        tx_crc=True, rx_crc=True, timeout=10)
        if err != OK or len(data) != 1:
            return err or COMM_ERR, 0
        return OK, data[0]

    def activate(self):
        """Full card activation. Returns (err, uid_bytes, sak)."""
        err, atqa = self.wakeup()
        if err != OK:
            return err, [], 0

        cascade = 1
        if (atqa[0] & 0xC0) == 0x40:
            cascade = 2
        elif (atqa[0] & 0xC0) == 0x80:
            cascade = 3

        full_uid = []
        sak = 0
        for lv in range(cascade):
            err, uid4, bcc = self.anticoll(lv)
            if err != OK:
                return err, [], 0
            if lv < cascade - 1:
                full_uid.extend(uid4[1:])
            else:
                full_uid.extend(uid4)
            err, sak = self.select(lv, uid4, bcc)
            if err != OK:
                return err, [], 0

        return OK, full_uid, sak

    def halt(self):
        """HALT — send halt command."""
        err, _, _ = self.transceive([0x50, 0x00], 0,
                                     tx_crc=True, rx_crc=True, timeout=10)
        # Timer error = success (no response expected)

    def ntag_read_page(self, page):
        """Read 4 pages (16 bytes) starting at page. Returns (err, data16)."""
        err, data, _ = self.transceive([0x30, page], 16,
                                        tx_crc=True, rx_crc=True, timeout=10)
        if err == OK and len(data) == 16:
            return OK, data
        return err or COMM_ERR, []

    def ntag_write_page(self, page, data4):
        """Write 4 bytes to a single NTAG page. Returns err code."""
        if len(data4) != 4:
            raise ValueError("NTAG page write requires exactly 4 bytes")
        err, resp, bits = self.transceive(
            [0xA2, page] + list(data4), 1,
            tx_crc=True, rx_crc=False, timeout=10)
        if err == OK:
            if resp and (resp[0] & 0x0F) == 0x0A:
                return OK
            return COMM_ERR
        return err

    def ntag_read_user_data(self, pages=TT_USER_PAGES):
        """Read user data pages (4–27 by default = 96 bytes). Returns (err, bytes)."""
        result = []
        for p in range(TT_USER_START, TT_USER_START + pages, 4):
            err, data = self.ntag_read_page(p)
            if err != OK:
                return err, []
            remaining = (TT_USER_START + pages - p) * 4
            result.extend(data[:min(16, remaining)])
        return OK, result

    def ntag_write_user_data(self, data_bytes):
        """Write data bytes to user area starting at page 4. Returns err code."""
        if len(data_bytes) > TT_USER_PAGES * 4:
            raise ValueError(f"Data too large: {len(data_bytes)} bytes, max {TT_USER_PAGES * 4}")
        # Pad to full page
        data = list(data_bytes)
        while len(data) % 4 != 0:
            data.append(0)
        for i in range(0, len(data), 4):
            page = TT_USER_START + (i // 4)
            err = self.ntag_write_page(page, data[i:i + 4])
            if err != OK:
                return err, page
        return OK, -1


class GPIOController:
    """Control coil switch and reset GPIOs via gpiod."""

    def __init__(self):
        import gpiod
        self.chip = gpiod.Chip('/dev/gpiochip1')
        self._lines = {}

    def _get_line(self, offset):
        if offset not in self._lines:
            import gpiod
            line = self.chip.get_line(offset)
            line.request(consumer='rfid-rw', type=gpiod.LINE_REQ_DIR_OUT, default_val=0)
            self._lines[offset] = line
        return self._lines[offset]

    def set(self, offset, value):
        self._get_line(offset).set_value(1 if value else 0)

    def release_all(self):
        for line in self._lines.values():
            try:
                line.release()
            except Exception:
                pass
        self._lines.clear()


def stop_openrfid():
    """Stop OpenRFID daemon so we can access SPI."""
    # Use init script if available
    for script in ['/etc/init.d/S99openrfid', '/etc/init.d/S60openrfid']:
        if os.path.exists(script):
            subprocess.run([script, 'stop'], capture_output=True, timeout=10)
            break

    # Kill any remaining python3 processes running openrfid
    try:
        result = subprocess.run(['pidof', 'python3'], capture_output=True, text=True)
        for pid in result.stdout.strip().split():
            try:
                cmdline = open(f'/proc/{pid}/cmdline', 'r').read()
                if 'openrfid' in cmdline.lower():
                    os.kill(int(pid), signal.SIGTERM)
            except (OSError, ValueError):
                pass
    except Exception:
        pass

    # Give it time to release SPI and GPIO
    time.sleep(1.0)


def start_openrfid():
    """Restart OpenRFID daemon."""
    for script in ['/etc/init.d/S99openrfid', '/etc/init.d/S60openrfid']:
        if os.path.exists(script):
            subprocess.run([script, 'start'], capture_output=True, timeout=10)
            return
    print("WARN: Could not find OpenRFID init script to restart", file=sys.stderr)


def setup_channel(gpio, channel):
    """Configure GPIO coil switches for the given channel."""
    cfg = CHANNELS[channel]
    gpio.set(27, cfg['gpio27'])
    gpio.set(24, cfg['gpio24'])
    time.sleep(0.05)


def hard_reset(gpio, channel):
    """Hard-reset the FM175xx chip for the given channel."""
    rst = CHANNELS[channel]['rst']
    gpio.set(rst, 0)
    time.sleep(0.3)
    gpio.set(rst, 1)
    time.sleep(0.3)


def hex_dump(data, offset=0, label=""):
    """Pretty hex dump with ASCII."""
    if label:
        print(f"\n── {label} ──")
    print(f"{'Offset':8s}  {'Hex':48s}  ASCII")
    print(f"{'──────':8s}  {'─' * 48}  {'─' * 16}")
    for i in range(0, len(data), 16):
        chunk = data[i:i + 16]
        hx = ' '.join(f'{b:02X}' for b in chunk)
        asc = ''.join(chr(b) if 32 <= b <= 126 else '.' for b in chunk)
        print(f"{offset + i:06X}    {hx:<48s}  {asc}")


# ── TigerTag decode ──────────────────────────────────────────

# Material and brand lookup tables (subset)
TT_MATERIALS = {
    0: 'PLA', 1: 'ABS', 2: 'PETG', 3: 'TPU', 4: 'PA/Nylon',
    5: 'PC', 6: 'ASA', 7: 'HIPS', 8: 'PVA', 9: 'PP',
    10: 'PEEK', 11: 'PEI', 65535: 'Unknown'
}

TT_BRANDS = {
    0: 'Snapmaker', 1: 'Bambu Lab', 2: 'Polymaker', 3: 'eSUN',
    4: 'Hatchbox', 5: 'Overture', 6: 'Prusament', 7: 'Inland',
    65535: 'Unknown'
}


def decode_tigertag(data):
    """Decode 96-byte TigerTag user data."""
    if len(data) < 48:
        print("  Not enough data to decode TigerTag")
        return

    tag_id = struct.unpack_from('>I', bytes(data), 0)[0]
    product_id = struct.unpack_from('>I', bytes(data), 4)[0]
    material_id = struct.unpack_from('>H', bytes(data), 8)[0]
    aspect1 = data[10]
    aspect2 = data[11]
    type_id = data[12]
    diameter_id = data[13]
    brand_id = struct.unpack_from('>H', bytes(data), 14)[0]
    r, g, b, a = data[16], data[17], data[18], data[19]
    weight = (data[20] << 16) | (data[21] << 8) | data[22]
    unit_id = data[23]
    hotend_min = struct.unpack_from('>H', bytes(data), 24)[0]
    hotend_max = struct.unpack_from('>H', bytes(data), 26)[0]
    drying_temp = data[28]
    drying_time = data[29]
    bed_min = data[30]
    bed_max = data[31]

    is_valid = (tag_id == TT_MAGIC)

    print(f"\n── TigerTag Decode {'(VALID)' if is_valid else '(INVALID magic)'} ──")
    print(f"  Tag ID:       0x{tag_id:08X} {'✓' if is_valid else '✗ expected 0x5BF59264'}")
    print(f"  Product ID:   0x{product_id:08X} ({product_id})")
    print(f"  Material:     {TT_MATERIALS.get(material_id, f'ID={material_id}')}")
    print(f"  Aspect 1/2:   {aspect1} / {aspect2}")
    print(f"  Type:         {type_id} {'(filament)' if type_id == 142 else ''}")
    print(f"  Diameter:     {diameter_id} {'(1.75mm)' if diameter_id == 56 else '(2.85mm)' if diameter_id == 221 else ''}")
    print(f"  Brand:        {TT_BRANDS.get(brand_id, f'ID={brand_id}')}")
    print(f"  Color:        #{r:02X}{g:02X}{b:02X} (A={a})")
    print(f"  Weight:       {weight} g")
    print(f"  Hotend:       {hotend_min}–{hotend_max} °C")
    print(f"  Drying:       {drying_temp} °C / {drying_time} h")
    print(f"  Bed:          {bed_min}–{bed_max} °C")

    if len(data) >= 46:
        td_raw = struct.unpack_from('>H', bytes(data), 44)[0]
        if td_raw:
            print(f"  TD:           {td_raw / 10:.1f}")


def _do_read(channel):
    """Read TigerTag user data. Returns dict with results."""
    gpio = GPIOController()
    reader = None
    try:
        stop_openrfid()
        cfg = CHANNELS[channel]
        setup_channel(gpio, channel)
        hard_reset(gpio, channel)

        reader = FM175xx(cfg['bus'], cfg['dev'])
        reader.init_type_a()
        reader.carrier_on()
        time.sleep(0.02)

        err, uid, sak = reader.activate()
        if err != OK:
            return {'ok': False, 'error': f'No tag found on channel {channel} (err={err})'}

        uid_hex = ''.join(f'{b:02X}' for b in uid)

        err, data = reader.ntag_read_user_data()
        if err != OK:
            return {'ok': False, 'error': f'Failed to read user data (err={err})', 'uid': uid_hex, 'sak': sak}

        data_hex = ''.join(f'{b:02x}' for b in data)

        # Save backup
        backup = f'/tmp/rfid_backup_ch{channel}.hex'
        with open(backup, 'w') as f:
            f.write(data_hex)

        return {'ok': True, 'uid': uid_hex, 'sak': sak, 'hex': data_hex}

    finally:
        if reader:
            try:
                reader.halt()
                reader.carrier_off()
                reader.close()
            except Exception:
                pass
        gpio.release_all()
        start_openrfid()


def cmd_read(channel):
    """Read and display TigerTag user data."""
    result = _do_read(channel)
    if not result['ok']:
        print(f"ERROR: {result['error']}")
        return False

    print(f"Tag found: UID={result['uid']}  SAK=0x{result['sak']:02X}")
    if result['sak'] != 0x00:
        print(f"WARNING: SAK=0x{result['sak']:02X} — this may not be an NTAG/Ultralight tag")
    print(f"Read {len(result['hex']) // 2} bytes of user data")
    print(f"HEX: {result['hex']}")
    print(f"Backup saved to /tmp/rfid_backup_ch{channel}.hex")
    decode_tigertag(bytes.fromhex(result['hex']))
    return True


def _do_write(channel, hex_data):
    """Write hex data to TigerTag user area. Returns dict with results."""
    if len(hex_data) != 192:
        return {'ok': False, 'error': f'Expected 192 hex chars (96 bytes), got {len(hex_data)}'}
    try:
        data = bytes.fromhex(hex_data)
    except ValueError as e:
        return {'ok': False, 'error': f'Invalid hex data: {e}'}

    gpio = GPIOController()
    reader = None
    try:
        stop_openrfid()
        cfg = CHANNELS[channel]
        setup_channel(gpio, channel)
        hard_reset(gpio, channel)

        reader = FM175xx(cfg['bus'], cfg['dev'])
        reader.init_type_a()
        reader.carrier_on()
        time.sleep(0.02)

        err, uid, sak = reader.activate()
        if err != OK:
            return {'ok': False, 'error': f'No tag found on channel {channel} (err={err})'}

        uid_hex = ''.join(f'{b:02X}' for b in uid)

        # Read current data for backup
        err_r, old_data = reader.ntag_read_user_data()
        if err_r == OK and old_data:
            backup = f'/tmp/rfid_pre_write_ch{channel}.hex'
            old_hex = ''.join(f'{b:02x}' for b in old_data)
            with open(backup, 'w') as f:
                f.write(old_hex)

        # Re-activate after reading
        reader.halt()
        time.sleep(0.01)
        err, uid, sak = reader.activate()
        if err != OK:
            return {'ok': False, 'error': f'Re-activation failed (err={err})', 'uid': uid_hex}

        # Write
        err, fail_page = reader.ntag_write_user_data(data)
        if err != OK:
            return {'ok': False, 'error': f'Write failed at page {fail_page} (err={err})', 'uid': uid_hex}

        # Verify: re-activate and read back
        verified = None
        reader.halt()
        time.sleep(0.01)
        err, uid, sak = reader.activate()
        if err == OK:
            err, verify_data = reader.ntag_read_user_data()
            if err == OK:
                verified = bytes(verify_data) == data

        return {'ok': True, 'uid': uid_hex, 'sak': sak, 'verified': verified}

    finally:
        if reader:
            try:
                reader.halt()
                reader.carrier_off()
                reader.close()
            except Exception:
                pass
        gpio.release_all()
        start_openrfid()


def cmd_write(channel, hex_data):
    """Write hex data to TigerTag user area."""
    result = _do_write(channel, hex_data)
    if not result['ok']:
        print(f"ERROR: {result['error']}")
        return False

    print(f"Tag found: UID={result['uid']}  SAK=0x{result['sak']:02X}")
    print("Write complete!")
    if result.get('verified') is True:
        print("VERIFIED — read-back matches written data ✓")
    elif result.get('verified') is False:
        print("WARNING: Verify mismatch!")
    else:
        print("WARNING: Could not verify (re-activation failed)")
    return True


def cmd_dump(channel):
    """Dump pages 0-33 (full header + user area)."""
    gpio = GPIOController()
    reader = None
    try:
        stop_openrfid()
        cfg = CHANNELS[channel]
        setup_channel(gpio, channel)
        hard_reset(gpio, channel)

        reader = FM175xx(cfg['bus'], cfg['dev'])
        reader.init_type_a()
        reader.carrier_on()
        time.sleep(0.02)

        err, uid, sak = reader.activate()
        if err != OK:
            print(f"ERROR: No tag found on channel {channel} (err={err})")
            return False

        uid_hex = ''.join(f'{b:02X}' for b in uid)
        print(f"Tag found: UID={uid_hex}  SAK=0x{sak:02X}")

        # Read pages 0-33 (header + user area + a few extra)
        all_data = []
        for p in range(0, 36, 4):
            err, data = reader.ntag_read_page(p)
            if err != OK:
                print(f"  Read error at page {p} (err={err})")
                break
            all_data.extend(data)

        if all_data:
            hex_dump(all_data, label=f"Channel {channel} — Pages 0–{len(all_data) // 4 - 1}")

            # Also decode user area
            if len(all_data) >= 112:  # need at least page 27 (byte 112)
                user_data = all_data[16:112]  # pages 4-27
                data_hex = ''.join(f'{b:02x}' for b in user_data)
                print(f"\nUser data hex: {data_hex}")
                backup = f'/tmp/rfid_backup_ch{channel}.hex'
                with open(backup, 'w') as f:
                    f.write(data_hex)
                print(f"Backup saved to {backup}")
                decode_tigertag(user_data)

        return True

    finally:
        if reader:
            try:
                reader.halt()
                reader.carrier_off()
                reader.close()
            except Exception:
                pass
        gpio.release_all()
        start_openrfid()


def cmd_decode(channel):
    """Read and decode TigerTag (same as read, with more detail)."""
    return cmd_read(channel)


# ── HTTP API Server ───────────────────────────────────────────

class RfidApiHandler(BaseHTTPRequestHandler):
    """Handles POST /read and POST /write for the RFID Spools web UI."""

    def log_message(self, fmt, *args):
        # Log to stderr with timestamp
        sys.stderr.write(f"[rfid-api] {fmt % args}\n")

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0 or length > 4096:
            return None
        return self.rfile.read(length)

    def do_POST(self):
        path = self.path.rstrip('/')

        if path == '/read':
            self._handle_read()
        elif path == '/write':
            self._handle_write()
        else:
            self._send_json(404, {'ok': False, 'error': 'Not found'})

    def do_GET(self):
        if self.path.rstrip('/') == '/status':
            self._send_json(200, {'ok': True, 'status': 'running'})
        else:
            self._send_json(404, {'ok': False, 'error': 'Not found'})

    def _handle_read(self):
        raw = self._read_body()
        if not raw:
            self._send_json(400, {'ok': False, 'error': 'Missing request body'})
            return
        try:
            req = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as e:
            self._send_json(400, {'ok': False, 'error': f'Invalid JSON: {e}'})
            return

        channel = req.get('channel')
        if channel not in (0, 1, 2, 3):
            self._send_json(400, {'ok': False, 'error': 'channel must be 0-3'})
            return

        try:
            result = _do_read(channel)
        except Exception as e:
            self._send_json(500, {'ok': False, 'error': str(e)})
            return

        self._send_json(200 if result['ok'] else 502, result)

    def _handle_write(self):
        raw = self._read_body()
        if not raw:
            self._send_json(400, {'ok': False, 'error': 'Missing request body'})
            return
        try:
            req = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as e:
            self._send_json(400, {'ok': False, 'error': f'Invalid JSON: {e}'})
            return

        channel = req.get('channel')
        if channel not in (0, 1, 2, 3):
            self._send_json(400, {'ok': False, 'error': 'channel must be 0-3'})
            return

        hex_data = req.get('data', '')
        if not isinstance(hex_data, str):
            self._send_json(400, {'ok': False, 'error': 'data must be a hex string'})
            return

        try:
            result = _do_write(channel, hex_data)
        except Exception as e:
            self._send_json(500, {'ok': False, 'error': str(e)})
            return

        self._send_json(200 if result['ok'] else 502, result)


def cmd_serve(port=8739):
    """Start the HTTP API server."""
    server = HTTPServer(('127.0.0.1', port), RfidApiHandler)
    print(f"rfid-rw API server listening on 127.0.0.1:{port}")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("Server stopped.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    action = sys.argv[1].lower()

    # 'serve' doesn't need a channel argument
    if action == 'serve':
        port = int(sys.argv[2]) if len(sys.argv) >= 3 else 8739
        cmd_serve(port)
        return

    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    try:
        channel = int(sys.argv[2])
    except ValueError:
        print(f"ERROR: Invalid channel: {sys.argv[2]}")
        sys.exit(1)

    if channel not in CHANNELS:
        print(f"ERROR: Channel must be 0-3, got {channel}")
        sys.exit(1)

    if action == 'read':
        ok = cmd_read(channel)
    elif action == 'write':
        if len(sys.argv) < 4:
            print("ERROR: write requires HEX_DATA argument (192 hex chars)")
            sys.exit(1)
        ok = cmd_write(channel, sys.argv[3])
    elif action == 'dump':
        ok = cmd_dump(channel)
    elif action == 'decode':
        ok = cmd_decode(channel)
    else:
        print(f"ERROR: Unknown action: {action}")
        print("Actions: read, write, dump, decode, serve")
        sys.exit(1)

    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
