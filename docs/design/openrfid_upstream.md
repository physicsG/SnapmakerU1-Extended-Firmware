---
title: OpenRFID Upstream Opportunities
---

# OpenRFID Upstream Opportunities

The [`68-app-rfid-spools`](../../overlays/firmware-extended/68-app-rfid-spools/)
overlay carries several files that live under `/usr/local/share/openrfid/`
and `/usr/local/bin/`. Some of those are pure U1 glue and belong in this
repository forever. Others are extensions or fixes to the OpenRFID
codebase that would be cleaner to land upstream — eliminating monkey-patches
and override files we currently ship as overlays.

This document is a backlog/triage of which pieces could be upstreamed,
in what order, and what the upstream change would need to look like.

## Quick triage

| File (relative to overlay `root/`) | Classification | Notes |
| --- | --- | --- |
| `usr/local/share/openrfid/tag/tigertag/processor.py` | **Upstream candidate** | Adds emoji, message, TD, `bed_temp_min`, `bed_temp_max` parsing — valid TigerTag fields the upstream parser is missing |
| `usr/local/share/openrfid/tag/tigertag/constants.py` | **Drop after upstream PR** | Byte-identical to upstream today; only shipped as a change-tracking pin |
| `usr/local/share/openrfid/filament/generic.py` | **Upstream candidate** | Adds optional `bed_temp_min_c`, `bed_temp_max_c`, `emoji`, `message` fields |
| `usr/local/share/openrfid/extensions/__init__.py` | **Upstream candidate** | Empty placeholder — confirms the overlay is creating a brand-new directory in OpenRFID's tree |
| `usr/local/share/openrfid/extensions/ntag_write.py` | **Upstream candidate** (needs API work) | NTAG215 write support + write HTTP endpoint. Currently a monkey-patch (`GpioEnabledRfidReader.scan` is hot-swapped). Needs an extension/plugin hook upstream first |
| `usr/local/bin/openrfid.py` | **Disappears** if extensions API lands | Only exists to call `extensions.ntag_write.install()` before `runpy.run_path("main.py", ...)` — replace with auto-loader |
| `usr/local/share/openrfid/extended/openrfid_rfid_spools.cfg` | **Maybe ship as example** | Webhook-exporter config (`tag_read` / `tag_parse_error` / `tag_not_present` → POST). Could ship as an example config in OpenRFID |
| `etc/init.d/S99openrfid` | **Investigate** | Overrides the stock init. Diff vs. upstream — if it only changes config path / args, an env var in the stock script would eliminate this override |
| `usr/local/bin/rfid-spools-api.py` | **Stays here** | U1-specific Spoolman bridge / channel state machine / `/spools/api/*` |
| `etc/init.d/S99rfid-spools` | **Stays here** | Init for our own service |
| `etc/nginx/fluidd.d/rfid-spools.conf` | **Stays here** | Nginx glue for `/spools/` |
| `usr/local/share/rfid-spools/html/**` | **Stays here** | UI — entirely ours |

## Recommended order of work

### 1. Cheap parser/field PRs (no API changes needed)

Submit a single PR to the OpenRFID repo containing the additive changes
in:

- `src/tag/tigertag/processor.py`
- `src/filament/generic.py`

Concrete diff (verified against upstream `suchmememanyskill/OpenRFID@main`):

| File | Delta | Summary |
| --- | --- | --- |
| `src/tag/tigertag/processor.py` | +28 lines | Parse the 4-byte emoji + 28-byte custom message at `Constants.OFF_METADATA` (already defined upstream as `48`). Populate `bed_temp_min_c`, `bed_temp_max_c`, `emoji`, `message` on the returned `GenericFilament`. Adds one debug log line. |
| `src/filament/generic.py` | +18 lines | Four new optional kwargs (`bed_temp_min_c`, `bed_temp_max_c`, `emoji`, `message`) with safe defaults (`0.0`, `0.0`, `""`, `""`); matching instance attrs; matching `to_dict()` keys. |

Both changes are **purely additive** — every new constructor argument
has a safe default, no existing callers break, no behavior change for
existing fields. Strong upstream candidate, single PR.

`src/tag/tigertag/constants.py` in the overlay is **byte-identical**
to upstream — we only ship it as a change-tracking pin. Once the PR
lands and we bump our overlay's pinned OpenRFID version, this file
can be removed from the overlay altogether.

Once merged, the overlay drops:

- `root/usr/local/share/openrfid/tag/tigertag/processor.py`
- `root/usr/local/share/openrfid/tag/tigertag/constants.py`
- `root/usr/local/share/openrfid/filament/generic.py`

### 2. Extensions / plugin loader (eliminates the monkey-patch)

Propose an OpenRFID **extensions API**:

- Auto-import every module under an `extensions/` package.
- Each module may expose an `install()` callable, which is invoked
  before the readers are constructed.
- Document a small contract for what `install()` is allowed to do
  (e.g., wrap reader methods, register HTTP handlers under a reserved
  loopback port range, subscribe to lifecycle events).

Once landed, our changes shrink dramatically:

- `extensions/ntag_write.py` becomes a clean first-class plugin (no
  monkey-patching of `GpioEnabledRfidReader.scan`).
- `bin/openrfid.py` is **deleted** — the stock launcher loads our
  plugin automatically.
- `extensions/__init__.py` (empty placeholder) is no longer ours to
  carry.

### 3. Stock-init parity for `S99openrfid`

Diff this overlay's `S99openrfid` against the upstream init to confirm
why we override it. If the only delta is configurability (e.g., choosing
the active `extended2.cfg`), ask upstream for a config-path env var so
we can drop the override entirely.

### 4. Optional: example config in OpenRFID

`openrfid_rfid_spools.cfg` could ship in OpenRFID as a reference example
for "use OpenRFID as a webhook source for an external service". Low
priority — purely cosmetic/discoverability.

## What stays here forever

After all the above lands upstream, this overlay should reduce to:

```
overlays/firmware-extended/68-app-rfid-spools/
├── README.md
├── root/
│   ├── etc/
│   │   ├── init.d/S99rfid-spools
│   │   └── nginx/fluidd.d/rfid-spools.conf
│   └── usr/local/
│       ├── bin/rfid-spools-api.py
│       └── share/rfid-spools/html/...
└── test/push.sh
```

That is the desired end state: this overlay only contains things that
are inherently U1- or firmware-specific (the Spoolman bridge service,
the nginx route, the web UI, and an init script).

## Cross-reference

- Overlay README: [`68-app-rfid-spools/README.md`](../../overlays/firmware-extended/68-app-rfid-spools/README.md)
- TigerTag write path lives in `extensions/ntag_write.py` — see the
  "Write path" section of the overlay README for the protocol details
  that any upstream review will need.

---

## PR #415 follow-up — canonical plan (supersedes triage above)

PR [#415](https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware/pull/415)
was closed by `@paxx12` with the direction that:

> *"The best approach is to create a SPA app, that exposes the data using
> currently accessible API without making any changes to OpenRFID … the SPA
> would already have access to Moonraker, Spoolman, RFID state, and
> everything."* — and, separately: *"Please do make changes to OpenRFID,
> expose an API for this, basically tag manipulation (read, presence,
> etc.), then we could consider having just frontend in this repo."*

This shifts the end state for the overlay: `rfid-spools-api.py` and the
entire `rfid_spools` Python package are **no longer "stays here
forever"** — they are deleted. The SPA in this repo talks only to
Moonraker (which already has a Spoolman proxy) and to OpenRFID via new
Moonraker remote methods exposed by an upstream OpenRFID controller.

### Decisions

1. **Start with the OpenRFID changes.** Land them upstream first, then
   bump `64-app-openrfid` and slim down `68-app-rfid-spools`.
2. **`enable_write` lives in user-accessible printer config**: the
   `[openrfid_api]` section in `~/printer_data/config/u1.cfg`. Default
   `false`. The SPA hides the Edit / Write / Clear UI when disabled.
3. **Spoolman access goes through Moonraker's existing `[spoolman]`
   proxy** (`/server/spoolman/proxy`, `/server/spoolman/status`) —
   same path Mainsail / Fluidd use. No nginx Spoolman proxy, no
   browser-side CORS work, no Python.

### Step 1 — OpenRFID upstream changes (in `OpenRFID/`)

1. **Promote NTAG write into `reader/fm175xx/`.** Add
   `Fm175xx.write_ntag_pages(start_page, data)` and a delegating
   `GpioEnabledRfidReader.write_ntag_pages(start_page, data)` framed by
   `start_session()` / `end_session()`. No monkey-patches.
2. **Pending-write queue inside `Runtime.loop`.** Add
   `Runtime.submit_write(slot, data, start_page)` that wakes the loop
   via `start_reading_tag(slot)` and blocks on a `threading.Event`. The
   loop drains a pending write before the normal scan and skips the
   read for that iteration.
3. **Last-scan cache.** `Runtime.last_scans: dict[int, LastScan]`
   populated wherever `_notify_exporters` is called. Carries event,
   uid, tag_type, parsed filament (serialisable), timestamp.
4. **New configurable entity `[openrfid_api]`** in
   `src/controllers/openrfid_api.py`, subclassing `MoonrakerController`.
   Reads `moonraker_socket_path` and `enable_write` (bool, default
   `false`). On connect: identifies as agent `openrfid` and registers:

   | Remote method            | Params                            | Behaviour                                              |
   | ------------------------ | --------------------------------- | ------------------------------------------------------ |
   | `openrfid/list_channels` | —                                 | Returns serialised `last_scans` + reader count + `enable_write` |
   | `openrfid/scan_slot`     | `{slot}`                          | Calls `runtime.start_reading_tag(slot)`                |
   | `openrfid/write_tag`     | `{slot, data_b64, start_page}`    | Gated on `enable_write`; calls `runtime.submit_write` |
   | `openrfid/clear_tag`     | `{slot}`                          | Gated on `enable_write`; writes 96 zero bytes from page 4 |
   | `openrfid/tigertag_encode` | `{spec}`                        | Encodes via the bundled JSON DB; returns `{data_b64, start_page}` |

5. **New exporter `[openrfid_agent_event_exporter]`** in
   `src/exporters/openrfid_agent_event.py`. Reacts to `tag_read` /
   `tag_parse_error` / `tag_not_present` and pushes events into a queue
   the API controller reads, broadcasting `notify_agent_event` (method
   `openrfid/scan`) to all Moonraker WS clients. Decoupled so the
   runtime stays import-safe when `[openrfid_api]` is disabled.
6. **TigerTag encoder** at `src/tag/tigertag/encoder.py`. Pure
   `encode(spec, registry_dir) -> (bytes, start_page)`. Mirrors the
   firmware-repo encoder (`tag_id = 0xBC0FCB97`, signature zeroed,
   timestamp `int(time.time()) - 946684800`, message at `OFF_MESSAGE` /
   `MESSAGE_LENGTH`). Reuses constants and the JSON DB already shipped
   under `tag/tigertag/database/`.
7. **Promote the parser changes** from this overlay's mirror into
   upstream `tag/tigertag/processor.py`, `tag/tigertag/constants.py`,
   and `filament/generic.py` (this is the previously planned "cheap
   parser/field PRs" item — fold it into the same upstream PR for
   round-trip-write correctness).
8. **`examples/u1.cfg`**: add commented-out
   ```ini
   [openrfid_api]
   moonraker_socket_path = /oem/printer_data/comms/moonraker.sock
   enable_write = false

   [openrfid_agent_event_exporter]
   ```
9. **README**: section "Moonraker agent API" listing the remote methods
   and `notify_agent_event` channel.
10. **Tests**: round-trip TigerTag encode → existing processor read;
    fake-reader pending-write drain in `Runtime.loop`.

### Step 2 — firmware overlay slim-down (in this repo, follow-up PR)

`overlays/firmware-extended/68-app-rfid-spools/` becomes
**static-assets-only**: nginx serves files verbatim, the browser does
everything dynamic via Moonraker WS / Moonraker Spoolman proxy / new
`openrfid/*` remote methods. *Static* does **not** mean a single
bundled file — modularisation is preserved (per-page `pages/<n>.html` +
`pages/<n>.js`, plus a new `lib/` for `moonraker.js`, `spoolman.js`,
`openrfid.js`, `tigertag.js`).

Delete from the overlay:

- `root/usr/local/bin/rfid-spools-api.py` and the entire
  `root/usr/local/lib/rfid_spools/` package
- `root/usr/local/share/openrfid/extensions/ntag_write.py`
- `root/usr/local/bin/openrfid.py` launcher override
- Mirrored `openrfid/tag/tigertag/*` and `openrfid/filament/generic.py`
- `root/etc/init.d/S99rfid-spools`
- The custom `S99openrfid` (revert to upstream)

Refactor:

- `64-app-openrfid` retargets the OpenRFID release that contains the
  new API + write support
- Add `components.rfid` switch in `02-firmware-config/` `extended2.cfg`
  that maps to `[openrfid_api] enable_write`
- `root/etc/nginx/fluidd.d/rfid-spools.conf` reduced to static-file
  serving of `/spools/`; `/spools/api/` reverse-proxy removed
- SPA pages keep their `pages/<name>.html` + `pages/<name>.js` layout;
  data sources change from local `/api/*` to Moonraker JSON-RPC and the
  Moonraker Spoolman proxy
- Hide Edit / Write / Clear UI when `enable_write` is false (read from
  `openrfid/list_channels` response)

### Sequencing

1. OpenRFID PR (step 1) lands.
2. Firmware PR (step 2) bumps `64-app-openrfid` and slims
   `68-app-rfid-spools`.
3. Update `docs/rfid_support.md` for the SPA + the `enable_write`
   switch; remove references to the deleted backend.

### Desired end state for `68-app-rfid-spools/` (revised)

```
overlays/firmware-extended/68-app-rfid-spools/
├── README.md
├── root/
│   ├── etc/nginx/fluidd.d/rfid-spools.conf   # static-only, no proxy
│   └── usr/local/share/rfid-spools/html/
│       ├── index.html
│       ├── style.css
│       ├── app.js
│       ├── router.js
│       ├── utils.js
│       ├── templates.js
│       ├── lib/
│       │   ├── moonraker.js     # WS JSON-RPC + agent-event subscribe
│       │   ├── openrfid.js      # wrappers around openrfid/* methods
│       │   ├── spoolman.js      # via /server/spoolman/proxy
│       │   └── tigertag.js      # any browser-side helpers
│       └── pages/
│           ├── spools.html / .js
│           ├── config-shared.html / .js
│           ├── config-slots.html / .js
│           └── config-spoolman.html / .js
└── test/push.sh
```

No Python, no init scripts, no daemons, no socket listeners, no
monkey-patches in this overlay.
