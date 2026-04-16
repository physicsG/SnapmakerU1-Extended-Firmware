# Klipper extras module: FILAMENT_TAG_WRITE G-code command
#
# Exposes NTAG tag writing to the Moonraker / web UI layer.
# Requires the NTAG write methods injected into fm175xx_reader.py
# by the rfid-spools overlay script.
#
# G-code:
#   FILAMENT_TAG_WRITE CHANNEL=<0-3> DATA=<hex>  [START_PAGE=4]
#   FILAMENT_TAG_READ  CHANNEL=<0-3>  — trigger a re-read of the tag
#
# Printer object query (raw NTAG bytes from last read):
#   GET /printer/objects/query?filament_tag
#   → { "result": { "status": { "filament_tag": {
#         "raw_data": { "0": "5BF59264...", "1": null, ... }
#       }}}}

import logging


class FilamentTag:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.fm175xx_reader = None

        gcode = self.printer.lookup_object('gcode')
        gcode.register_command(
            'FILAMENT_TAG_WRITE',
            self.cmd_FILAMENT_TAG_WRITE,
            desc="Write hex data to an NTAG tag on the given channel",
        )
        gcode.register_command(
            'FILAMENT_TAG_READ',
            self.cmd_FILAMENT_TAG_READ,
            desc="Trigger a re-read of the tag on the given channel",
        )

        self.printer.register_event_handler("klippy:ready", self._handle_ready)

    def _handle_ready(self):
        try:
            fd = self.printer.lookup_object('filament_detect')
            self.fm175xx_reader = fd._fm175xx_reader
        except Exception as e:
            logging.warning("filament_tag: could not get fm175xx_reader: %s", e)

    # ── Printer object status (queryable via Moonraker) ──────
    def get_status(self, eventtime):
        reader = self.fm175xx_reader
        raw = {}
        ntag_raw = getattr(reader, '_ntag_raw_data', {}) if reader else {}
        for ch, data in ntag_raw.items():
            raw[str(ch)] = bytes(data).hex().upper() if data else None
        return {'raw_data': raw}

    # ── G-code: FILAMENT_TAG_WRITE ───────────────────────────
    def cmd_FILAMENT_TAG_WRITE(self, gcmd):
        channel = gcmd.get_int('CHANNEL', 0)
        data_hex = gcmd.get('DATA', '')
        start_page = gcmd.get_int('START_PAGE', 4)

        if not data_hex:
            raise gcmd.error("FILAMENT_TAG_WRITE: DATA parameter required")
        try:
            data = list(bytes.fromhex(data_hex))
        except ValueError:
            raise gcmd.error("FILAMENT_TAG_WRITE: invalid hex in DATA")

        if channel < 0 or channel > 3:
            raise gcmd.error("FILAMENT_TAG_WRITE: CHANNEL must be 0-3")

        reader = self.fm175xx_reader
        if reader is None:
            raise gcmd.error("FILAMENT_TAG_WRITE: RFID reader not available")
        if getattr(reader, 'enabled', True) is False:
            raise gcmd.error("FILAMENT_TAG_WRITE: RFID reader is disabled")

        try:
            # Queue the write — returns immediately, reader thread executes it
            reader.write_ntag_data(channel, data, start_page)
        except Exception as e:
            raise gcmd.error("FILAMENT_TAG_WRITE: %s" % str(e))

        # Poll for result using reactor.pause() — properly yields the reactor
        reactor = self.printer.get_reactor()
        deadline = reactor.monotonic() + 10.0
        while reactor.monotonic() < deadline:
            if reader._ntag_write_result is not None:
                res = reader._ntag_write_result
                reader._ntag_write_result = None
                if res.get('success'):
                    gcmd.respond_info(
                        "NTAG write OK: ch=%d, %d bytes at page %d"
                        % (channel, len(data), start_page)
                    )
                    return
                raise gcmd.error(
                    "FILAMENT_TAG_WRITE: %s" % res.get('error', 'write failed')
                )
            reactor.pause(reactor.monotonic() + 0.1)

        reader._pending_ntag_write = None
        raise gcmd.error(
            "FILAMENT_TAG_WRITE: Write timed out on channel %d" % channel
        )

    # ── G-code: FILAMENT_TAG_READ ────────────────────────────
    def cmd_FILAMENT_TAG_READ(self, gcmd):
        channel = gcmd.get_int('CHANNEL', 0)
        if channel < 0 or channel > 3:
            raise gcmd.error("FILAMENT_TAG_READ: CHANNEL must be 0-3")

        reader = self.fm175xx_reader
        if reader is None:
            raise gcmd.error("FILAMENT_TAG_READ: RFID reader not available")

        reader.request_read_card_info(channel)

        # Wait for the read cycle to populate _ntag_raw_data
        reactor = self.printer.get_reactor()
        deadline = reactor.monotonic() + 10.0
        old_data = getattr(reader, '_ntag_raw_data', {}).get(channel)
        while reactor.monotonic() < deadline:
            cur = getattr(reader, '_ntag_raw_data', {}).get(channel)
            if cur is not None and cur is not old_data:
                hex_str = bytes(cur).hex().upper()
                gcmd.respond_info(
                    "NTAG read OK: ch=%d, %d bytes" % (channel, len(cur))
                )
                return
            reactor.pause(reactor.monotonic() + 0.2)

        gcmd.respond_info(
            "FILAMENT_TAG_READ: no NTAG data after read (ch=%d, tag may be M1 or absent)"
            % channel
        )


def load_config(config):
    return FilamentTag(config)
