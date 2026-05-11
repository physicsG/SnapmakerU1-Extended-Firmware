# 68-app-rfid-spools

Static SPA at `/spools/` for managing RFID-tagged filament spools on the
Snapmaker U1 extended firmware. All dynamic data flows through the
printer's existing Moonraker connection — there is **no local API
backend, init script, or daemon** in this overlay.

## Architecture

```
┌──────────────────────┐  Moonraker JSON-RPC + WebSocket  ┌──────────────────────┐
│  rfid-spools SPA     │ ───────────────────────────────> │  Moonraker           │
│  (static, /spools/)  │                                  │  (existing service)  │
│  - lib/moonraker.js  │ <──────── notify_agent_event(openrfid/scan) ──────────  │
│  - lib/openrfid.js   │                                  │   ├─ /server/spoolman/proxy ──> Spoolman
│  - lib/spoolman.js   │                                  │   └─ Unix socket ──> OpenRFID agent
│  - lib/tigertag.js   │                                  └──────────────────────┘
└──────────────────────┘                                                │
        ▲                                                               │ openrfid_api controller
        │ static assets via nginx                                       │ (in OpenRFID daemon)
        │                                                               ▼
        │                                                  ┌──────────────────────┐
        └────── /spools/ static alias ────────────────────│  OpenRFID daemon     │
                                                          │  - openrfid/* methods│
                                                          │  - notify_agent_event│
                                                          │  - NTAG write queue  │
                                                          └──────────────────────┘
```

The OpenRFID agent is registered by the upstream
[`openrfid_api`](https://github.com/suchmememanyskill/OpenRFID) controller
(installed by [64-app-openrfid](../64-app-openrfid/)). This overlay only
provides the static SPA, the nginx config that serves it, and a small
OpenRFID config snippet that turns the agent on.

## Components

### Static SPA — [root/usr/local/share/rfid-spools/html/](root/usr/local/share/rfid-spools/html/)

- Shell: `index.html`, `style.css`, `app.js`, `router.js`, `utils.js`,
  `templates.js`
- `lib/`: thin wrappers around Moonraker, OpenRFID `openrfid/*` remote
  methods, the `/server/spoolman/proxy` REST proxy, and TigerTag display
  helpers.
- `pages/`: `spools.{html,js}`, `config-shared.{html,js}`,
  `config-slots.{html,js}`, `config-spoolman.{html,js}` — each page is a
  template + script pair using `Templates.clone(id)`.

### Remote methods consumed (registered by OpenRFID)

| Method                     | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `openrfid/list_channels`   | enumerate slots, latest scan per slot, write_enabled flag  |
| `openrfid/scan_slot`       | trigger a manual scan on a slot                            |
| `openrfid/write_tag`       | write raw bytes to NTAG215 user pages (gated)              |
| `openrfid/clear_tag`       | erase NTAG215 user pages with zeroes (gated)               |
| `openrfid/tigertag_encode` | encode a TigerTag spec into a 96-byte payload              |

Live scan updates arrive on `notify_agent_event` with
`agent="openrfid", event="openrfid/scan", data={slot, uid, tag_type, filament, …}`.

Spoolman queries go through Moonraker's built-in
`POST /server/spoolman/proxy` — same pattern Mainsail/Fluidd use.

### OpenRFID config snippet — [openrfid_api.cfg](root/usr/local/share/openrfid/extended/openrfid_api.cfg)

Added to the OpenRFID daemon's config merge list by
[64-app-openrfid/S99openrfid](../64-app-openrfid/root/etc/init.d/S99openrfid)
(it picks up every `/usr/local/share/openrfid/extended/openrfid_*.cfg`
that is not one of the `_u1_*` or `_user` files). Defines the
`[openrfid_api]` agent and `[openrfid_agent_event_exporter]` and pins
`enable_write = false` as the safe default.

### Write enable flag

Writes (`write_tag`, `clear_tag`) are read-only by default. To enable:

```ini
# /oem/printer_data/config/extended/extended2.cfg
[components]
rfid_write: true
```

`S99openrfid` reads this on startup and emits a runtime override at
`/tmp/openrfid_api_overrides.cfg` that promotes `enable_write` to true.
The SPA hides Edit / Write / Clear UI when
`openrfid/list_channels` reports `write_enabled: false`.

### Nginx — [rfid-spools.conf](root/etc/nginx/fluidd.d/rfid-spools.conf)

Static-only: redirects `/spools` → `/spools/`, then serves the SPA from
`/usr/local/share/rfid-spools/html/` behind the same `auth_request` guard
the rest of the firmware uses. No reverse proxy.

It also exposes the OpenRFID-shipped TigerTag JSON registry under
`/spools/static/openrfid/database/` (alias of
`/usr/local/share/openrfid/tag/tigertag/database/`, cached for one hour)
so the in-browser TigerTag encoder can resolve `id_material.json`,
`id_brand.json`, etc. without an API round-trip.

## Related Klipper patches — [../13-patch-rfid/patches/](../13-patch-rfid/patches/)

- `01-add-ntag215-support.patch`
- `02-add-ndef-protocol.patch`
- `03-fm175xx-reader-enabled-guard.patch`
- `04-filament-detect-reader-enabled-guard.patch`
- `05-add-filament-detect-set-endpoint.patch`

## Development workflow

```bash
# Quick push to printer for testing
./overlays/firmware-extended/68-app-rfid-spools/test/push.sh root@<printer-ip>
```
