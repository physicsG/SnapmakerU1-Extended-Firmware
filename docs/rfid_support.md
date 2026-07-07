---
title: RFID Filament Tag Support
---

# RFID Filament Tag Support


The Snapmaker U1 automatically detects filament properties by reading RFID tags on spools.

**Firmware Support:**
- **Original:** Mifare Classic 1K with Snapmaker proprietary format
- **Extended:** Adds NTAG215/216 support with OpenSpool format

## Supported Formats

| Feature | OpenSpool 🏆 | OpenPrintTag | OpenTag3D | Snapmaker |
|---------|--------------|--------------|-----------|-----------|
| **Tag Type** | NTAG215 (540 bytes) / NTAG216 (888 bytes) | ISO15693/SLIX2 | NTAG215/216 or ISO15693/SLIX2 | Mifare Classic 1K |
| **Encoding** | JSON (NDEF) | CBOR (NDEF) | Binary | Proprietary + RSA signature |
| **Data Format** | Human-readable JSON | Compact CBOR binary | Binary | Encrypted proprietary |
| **Specification** | [openspool.io](https://openspool.io/rfid.html) | [specs.openprinttag.org](https://specs.openprinttag.org/#/) | [OpenTag3D](https://github.com/prusa3d/OpenTag3D) | Proprietary (closed) |
| **GitHub Repository** | [spuder/OpenSpool](https://github.com/spuder/OpenSpool) | [prusa3d/OpenPrintTag](https://github.com/prusa3d/OpenPrintTag) | [queengooborg/OpenTag3D](https://github.com/queengooborg/OpenTag3D) | N/A |
| **Popularity** | ⭐⭐⭐ (623 stars) | ⭐⭐ (213 stars) | ⭐ (17 stars) | N/A |
| **Programming Tools** | Any NDEF-capable NFC app | Prusa app only | [opentag3d.info/make](https://opentag3d.info/make) | Snapmaker official only |
| **U1 Compatible** | ✅ Yes (extended firmware) | ❌ No (ISO15693 not supported) | ⚠️ Not implemented yet | ✅ Yes (all firmware) |
| **Ease of Programming** | Easy (any NFC app) | Medium (requires Prusa app) | Medium (web-based tool) | Hard (official tags only) |
| **Data Portability** | High (simple JSON) | High (open CBOR spec) | Medium (binary format) | None (proprietary) |

🏆 = Recommended for U1 (NTAG215 is the sweet spot for capacity and compatibility)

## How It Works

Tags are automatically read when filament is loaded into the feeder. Tag data clears when filament is removed.

**Manual Commands:**
- Read tag: `FILAMENT_DT_UPDATE CHANNEL=<n>`
- Clear tag data: `FILAMENT_DT_CLEAR CHANNEL=<n>`
- Check current tag: `FILAMENT_DT_QUERY CHANNEL=<n>`

## Programming Filament Tags

### OpenSpool (Recommended for Extended Firmware)

**Quick Setup:**
1. Get NTAG215 or NTAG216 tags
2. Open Chrome on Android phone
3. Visit [printtag-web.pages.dev](https://printtag-web.pages.dev)
4. Enter filament information
5. Tap tag to phone to write

**Alternative:** Use any NFC app that supports NDEF with JSON (MIME type: `application/json`)

Example payload:
```json
{
  "protocol": "openspool",
  "version": "1.0",
  "brand": "Generic",
  "type": "PLA",
  "color_hex": "#FF0000",
  "min_temp": 190,
  "max_temp": 220,
  "bed_min_temp": 50,
  "bed_max_temp": 60
}
```

Using the non-standard OpenSpool `subtype` field it is possible to specify a material subtype:

```json
{
  "protocol": "openspool",
  "version": "1.0",
  "type": "PETG",
  "subtype": "Rapid",
  "color_hex": "AFAFAF",
  "additional_color_hexes": ["EEFFEE","FF00FF"],
  "alpha": "FF",
  "brand": "Elegoo",
  "min_temp": "230",
  "max_temp": "260"
}
```

### OpenSpool Field Reference

**Required Fields:**
- `protocol` - Must be "openspool"
- `version` - Specification version (e.g., "1.0")
- `type` - Material type (PLA, PETG, ABS, TPU, etc.)
- `color_hex` - Color in hex format (#RRGGBB)

**Optional Standard Fields:**
- `brand` - Manufacturer name
- `min_temp` / `max_temp` - Nozzle temperature range in °C

**Optional Extended Fields (U1-specific):**
- `bed_min_temp` / `bed_max_temp` - Bed temperature range in °C
- `subtype` - Material variant (Basic, Rapid, HF, Silk, etc.)
- `alpha` - Color transparency (00-FF hex, default: FF)
- `additional_color_hexes` - Additional colors for multicolor spools (up to 4)
- `weight` - Spool weight in grams
- `diameter` - Filament diameter in mm (e.g., 1.75)

### Snapmaker Orca Naming Convention

Snapmaker Orca requires filaments to follow this naming pattern: `<brand> <type> <subtype>`

Examples: `Generic PLA Basic`, `Elegoo PETG Rapid`

## Reading Existing Tags

Use the **NFC Tools** app (iOS/Android) to inspect tags:

1. Download NFC Tools from App Store or Google Play
2. Tap "Read" and hold tag to phone
3. Check tag type and NDEF records

**Compatible tag types:** NTAG213/215/216, Mifare Classic 1K
**Note:** ISO15693 tags (OpenPrintTag) are not supported

## Alternative Detection Systems


The OpenRFID detection system is an alternative to Snapmaker's built-in filament tag detection, based on the [OpenRFID](https://github.com/suchmememanyskill/OpenRFID) project. It adds support for tagged spools from multiple manufacturers.

To enable it, navigate to the [firmware-config](firmware_config.md) web interface, go to **Snapmaker Components > RFID Detection System**, and select **OpenRFID** or **OpenRFID (force generic vendor)**.

- **OpenRFID** - Filament is identified by brand and type. Spools unrecognized by Snapmaker Orca are hidden in Snapmaker Orca.
- **OpenRFID (force generic vendor)** - Same as OpenRFID, but spools are labeled as Generic so they always appear in Snapmaker Orca.
- **External** - Disables the built-in readers entirely, useful for external readers such as [wasikuss/snapmaker-u1-remote-rfid-reader](https://github.com/wasikuss/snapmaker-u1-remote-rfid-reader).

### Supported Tags

| System | Enabled by default | Remarks |
|--------|-------------------|---------|
| Bambu | No | Requires additional configuration (see below) |
| Creality | No | Requires additional configuration (see below) |
| Anycubic | Yes | - |
| Snapmaker | Yes | - |
| Elegoo | No | Elegoo spools tagged with RFID work unreliably |
| [OpenSpool](https://openspool.io/) | Yes | - |
| TigerTag | Yes | Fully offline implementation |
| Qidi | Yes | - |
| [SpoolEase](https://spoolease.io/) | No | NTAG NDEF tags; enable the processor to use |

### Bambu / Creality Spool Configuration

Bambu and Creality tagged spools require authentication keys. Edit the user configuration file to enable them:

```
/oem/printer_data/config/extended/openrfid_user.cfg
```

For **Bambu** spools:
```ini
[bambu_lab_tag_processor]
key = <your 32 hex character key>
```

For **Creality** spools:
```ini
[creality_tag_processor]
key = <your 32 hex character key>
encryption_key = <your 32 hex character key>
```

After editing, restart the printer.

### Enabling Disabled By Default Tag systems

Some tag formats are disabled by default, for example as they do not read reliably. You can enable them by editing the following file:

```
/oem/printer_data/config/extended/openrfid_user.cfg
```

Enable them by removing the `#` prefix from the tag processor.

```
# [elegoo_tag_processor]
```

[SpoolEase](https://spoolease.io/) tags (NTAG NDEF) are also supported but not
enabled by default. Add the processor to the same file to use them:

```ini
[spoolease_tag_processor]
```

### Spools Web App (`/spools/`)

The extended firmware ships a small single-page app at `http://<printer>/spools/`
that talks directly to Moonraker and the OpenRFID Moonraker agent over
WebSocket — there is no per-app backend service.

What it offers:

- Live view of every channel's filament tag, color, temperatures and (when
  available) the linked Spoolman spool.
- "Spool picker" that searches your Spoolman library and links a spool to
  the tag's UID — the link is stored in Moonraker's database under the
  `rfid_spools` namespace, so it survives reboots and Moonraker restarts.
- "Sync to Spoolman" round-trip that updates an existing spool, or creates
  one in your default vendor and links it on the spot. Optional Spoolman
  *extra fields* (drying temp, manufacturing date, modifiers, …) are
  registered from the **Config → Spoolman** sub-page in one click.
- "Edit / Write / Clear" buttons for NTAG215 tags. These are gated on the
  **RFID Tag Writing** firmware-config toggle (see below) so that printers
  without an authoring use-case never expose write affordances. The
  TigerTag encoder used to author tags is served straight from the
  on-printer database directory (`/usr/local/share/openrfid/tag/tigertag/database/`)
  via an nginx alias under `/spools/static/openrfid/database/`.

What changed compared to the original cgi-backed implementation:

- Auto-discover Spoolman is no longer offered. Enter the URL on the
  **Config → Spoolman** sub-page; Save writes
  `/oem/printer_data/config/extended/moonraker/05_spoolman.cfg` (the file
  is `[include]`-d into `moonraker.conf`) and triggers a Moonraker
  self-restart so the change takes effect immediately. No firmware-config
  toggle is required — the Spools page owns Spoolman wiring end to end.
- All Spoolman traffic goes through Moonraker's `/server/spoolman/proxy`,
  so the same authentication and CORS rules as the rest of Fluidd apply.

### Configuring Spoolman

1. Open `http://<printer>/spools/`.
2. Go to **Config → Spoolman**.
3. Paste the Spoolman base URL (e.g. `http://spoolman.local:7912`) and
   click **Save**. The status badge will go to `…` while Moonraker
   restarts (~5–10 s) and then back to `Connected ✓` once the
   `[spoolman]` section is live.
4. Optionally tick the **extra fields** you want synced and click
   **Register fields in Spoolman** so the SPA can write things like
   drying temperature and modifiers into your Spoolman library.

If you previously stored the Spoolman URL in the legacy
`/oem/printer_data/config/extended/rfid-spools.json`, the OpenRFID init
script migrates it on first boot — the file is renamed to
`rfid-spools.json.migrated` afterwards and never touched again.

### Enabling tag writing

NTAG215 writing is **off by default**. To enable it, open
[firmware-config](firmware_config.md), navigate to **Snapmaker Components →
RFID Tag Writing**, and choose **Enabled**. This sets `rfid_write = true`
under `[components]` in `extended2.cfg`, which the OpenRFID init script
plumbs through to the agent's `enable_write` flag. With the toggle off,
the Spools UI hides the Write/Clear/Edit buttons and the agent rejects
write requests.

#### Write smoke test

After enabling the toggle and rebooting:

1. Hard-refresh `http://<printer>/spools/` (the SPA caches templates).
2. Drop an NTAG215 tag on a reader. The channel row should show
   **Edit**, **Write** and **Clear** buttons next to the tag info.
3. Click **Edit**, change a field (e.g. colour), then **Write**. The
   status line should report a successful write.
4. Remove the tag and re-present it; the new value should appear on read.
5. **Clear** wipes the tag back to factory state — useful when
   re-authoring a partially-written tag.

If the buttons don't appear, double-check `rfid_write` in
`/oem/printer_data/config/extended/extended2.cfg`, then
`/etc/init.d/S99openrfid restart` to reload the agent.

## Troubleshooting

**Tag not detected:**
- Ensure tag is NTAG213/215/216 or Mifare Classic 1K
- Position tag within 1-3cm of reader antenna
- Ensure you place on tag on the side next to the U1 housing, which will depend on which side of the printer you load the spool
- If a vendor tag is present, for example Bambu Lab filament tags, this will usually interfere with reading a user-provided tag (you can cover up the vendor tag with foil tape)
- Manually read tag: `FILAMENT_DT_UPDATE CHANNEL=<n>` then `FILAMENT_DT_QUERY CHANNEL=<n>`
- For OpenRFID issues, open Fluidd **Logs** and fetch `openrfid.log`

**OpenPrintTag tags don't work:**
- Expected - OpenPrintTag uses ISO15693 which is not supported by U1 hardware
- Use NTAG tags with OpenSpool format instead

**NTAG tags only work on extended firmware:**
- Original firmware only supports Mifare Classic 1K with Snapmaker proprietary format
- Extended firmware adds NTAG215/216 support
