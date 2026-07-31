---
title: Filament RFID Write Port
---

# Filament RFID Write Port

This is the working document for adding safe RFID authoring to PAXX's
/filament application on a clean branch rooted at upstream/main. The old
/spools application is a reference implementation only and is not part of
this branch.

## Baseline

- Branch: feat/filament-rfid-write
- Root commit: upstream/main at ff6e2cf (v1.4.1-paxx12-20)
- Official Filament UI: upstream commit 70726ac
- Official service hooks: upstream commit 276a71a
- Official Spoolman/SpoolLink: upstream commit bad8efb plus correctness
  follow-up 868c13d
- RFID default fix: upstream commit 8c20d3e
- Write-capable OpenRFID: physicsG/OpenRFID at
  1d8229b307429adbcb73869d55637a61fee2a284
- TigerTag SDK database pin:
  f3e2e2e8a1fdf88f91fb43ca4b5c5fbfb88f81af

The OpenRFID pin is temporary. Return to official OpenRFID only after its main
branch exposes an equivalent channel API, rich decoded model, and safe physical
writer.

## Scope

The finished /filament page must:

- preserve PAXX's four-channel view, user filament editor, mismatch handling,
  Spoolman assignment, and SpoolLink UID ownership;
- show configuration source, payload format, physical tag technology, and
  authentication as independent facts;
- show every field supplied by OpenRFID, including all colors, quantities,
  nozzle and bed ranges, drying data, date, name/message, and transmission
  distance;
- rank likely Spoolman matches without automatically accepting a fuzzy match;
- author, edit, verify, and clear supported TigerTag Maker payloads;
- retain the Add fields to Spoolman action and explicit metadata-sync preview;
- continue to work as the stock PAXX page when the OpenRFID agent is absent.

This branch must not add an nginx /spools route, static /spools application,
legacy rfid-spools.json migration, legacy slot_spool_links store, or direct
browser ownership of Spoolman card_uids.

## Model decision

PAXX does not use TigerTag as its base model. Its page combines
filament_detect, print_task_config, and an optional Spoolman record. Keep those
as the effective printer and inventory layers.

OpenRFID GenericFilament is the format-neutral decoded layer. It preserves
common fields plus present_fields and format_data so that format-specific data
is not discarded. TigerTag is one decoder/encoder behind that model.

New tags are encoded as official TigerTag Maker records through the pinned
TigerTag Python SDK. Do not reproduce the binary format in browser JavaScript.
Spoolman filament.name and TigerTag custom_message remain separate values.

## Channel layers

Each visible channel merges four independent layers:

1. Physical tag: slot, card UID, reader technology, presence, and scan time.
2. Decoded payload: format, processor, all present fields, raw format data,
   and authentication state.
3. Printer configuration: Official/User source, material, vendor, colors,
   temperatures, and assigned spool ID.
4. Spoolman: selected spool and filament inventory.

UID-bearing OpenRFID events are accepted only when both slot and normalized UID
match current filament_detect state. A delayed absence event must be confirmed
against fresh printer state before it clears a newer tag.

The existing Official badge describes where the printer configuration came
from; it is not proof of tag format or cryptographic authenticity. A channel
may legitimately show Official, Spoolman, TigerTag, NTAG, and Unsigned at the
same time.

## Tag-format plumbing

TAG_FORMAT is the minimal fallback field carried through filament_detect.
Built-in readers set snapmaker or openspool. OpenRFID exporters set the stable
format identifier returned by their processor. SpoolLink must preserve
CARD_UID, CARD_TYPE, and TAG_FORMAT when it applies a Spoolman profile.

Rich fields stay in the OpenRFID agent response instead of continually
expanding the OEM filament structure.

## Matching

Canonical Spoolman card_uids are authoritative. Exact UID matches are shown
first and duplicate owners are surfaced as conflicts.

Fuzzy candidates are advisory and are ranked from normalized vendor, material,
variant, all colors, and name/message signals. Archived spools are excluded,
search terms are ANDed, and a spool appears in only one group. Selection still
uses PAXX's SET_SPOOL_ID and SpoolLink path; the browser never patches UID
ownership directly.

## How writing works

1. /filament discovers OpenRFID capabilities through Moonraker's agent bridge.
2. The editor is shown only for a compatible physical tag and an enabled
   server capability.
3. The browser validates a structured draft, including TigerTag registry
   values and the 28-byte UTF-8 message limit.
4. OpenRFID's tigertag_encode method uses the official SDK to produce one
   80-byte Maker payload for pages 4 through 23.
5. The user confirms the target slot, current seven-byte UID, format, and
   complete preview.
6. write_tag or clear_tag repeats server-side gates: write policy, print
   state, UID, tag class/capacity, format/signature rules, and per-reader lock.
7. The writer invalidates the header, writes the body, writes the header last,
   reads the owned region back, decodes it, and reports a structured operation
   result.
8. On a client timeout, the UI queries operation_status rather than blindly
   retrying a physical write.
9. The UI rescans the same UID and compares every written field before
   reporting success.

TigerTag+ remains read-only. Initializing a blank or unrecognized NTAG and
migrating the exact retired OpenRFID-v1 fingerprint require separate server
and per-operation confirmations.

## Configuration

Reader selection remains in the components section:

    [components]
    rfid: snapmaker

Write policy belongs in its own section:

    [openrfid]
    enable_write: false
    allow_unrecognized_write: false
    allow_legacy_migration_write: false

Firmware Config exposes those keys in a separate OpenRFID group. S99openrfid
translates them into a final temporary openrfid_api override only when the
installed tree contains SAFE_TIGERTAG_WRITER_V2. The static API configuration
sets all permissions false. Missing, malformed, or old settings therefore fail
closed.

## Spoolman fields

SpoolLink continues to own its core schema and card_uids. The /filament Add
fields dialog detects missing, ready, legacy, and type-mismatched optional
metadata fields. It creates only explicitly selected missing definitions.

Creating a schema does not copy tag metadata. Metadata is written only through
a separate preview that lists changed fields and conflicts, patches approved
values, rereads the record, and verifies the result. It never writes card_uids
or legacy rfid_uid.

## Port phases

- [x] Create an isolated branch/worktree rooted at current upstream/main.
- [x] Import the official /filament UI.
- [x] Import the minimum official service-hook and SpoolLink dependencies.
- [x] Verify the pinned OpenRFID suite (131 passed, 1 skipped).
- [ ] Add the consolidated OpenRFID service configuration and immutable pins.
- [ ] Add TAG_FORMAT fallback plumbing and SpoolLink identity preservation.
- [ ] Port rich agent reads, independent badges, and complete field rendering.
- [ ] Port grouped matching while retaining SET_SPOOL_ID.
- [ ] Port guarded TigerTag authoring, write, clear, recovery, and verification.
- [ ] Port Add fields to Spoolman and explicit metadata sync.
- [ ] Run JavaScript, Python, shell, and embedded-patch validation.
- [ ] Complete a full firmware build against the main firmware baseline.
- [ ] Perform all-four-slot physical acceptance before enabling writing.

## Acceptance checklist

- Basic /filament remains usable when OpenRFID is stopped.
- Official and actual tag format are displayed independently.
- Missing values and meaningful zero values are not conflated.
- Name/message, transmission distance, all colors, and ranges round-trip.
- Wrong UID, removed/swapped tag, active print, insufficient capacity, locked
  pages, busy reader, timeout, partial write, and read-back mismatch fail
  visibly and safely.
- All writes default off on both fresh and existing configurations.
- Spool assignment uses SpoolLink and fuzzy matches require user confirmation.
- Optional Spoolman metadata is registered and synchronized only explicitly.
- No /spools route, assets, config migration, or private UID mapping is added.

