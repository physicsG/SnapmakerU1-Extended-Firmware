# AI Agent Rules for Snapmaker U1 Extended Firmware

## Project Overview

This repository builds custom firmware for the Snapmaker U1 3D printer using a modular overlay system. It extends the stock firmware with debug tools, SSH access, Klipper support, camera apps, and other device-specific enhancements.

The build workflow is Docker-based and centered around `./dev.sh`, `Makefile` targets, and overlay directories under `overlays/`.

> **GitHub coding agent**: when working on a GitHub issue or pull request,
> also follow [copilot-issue-instructions.md](copilot-issue-instructions.md)
> (visual evidence, PR description template, validation requirements).

## General Coding Principles

- **ALWAYS** make the minimum amount of changes needed to solve the task.
- **ALWAYS** follow existing repo conventions and overlay patterns.
- **ALWAYS** prefer simple, robust shell scripting and patch workflows.
- **ALWAYS** test functional changes where possible.
- **ALWAYS** use clear, descriptive names for patches, overlays, variables, and scripts.
- **ALWAYS** document build or overlay behavior changes in `docs/` or overlay README files.

## Core Rules

### 1. Build Environment

- **ALWAYS** use `./dev.sh` to run commands inside the containerized build environment.
- **ALWAYS** use `./dev.sh make ...` for Makefile targets when building or extracting firmware.
- **NEVER** install build dependencies globally on the host unless absolutely required.
- **NEVER** assume native host tools are available; prefer the repository-provided Docker setup.

### 2. Overlay and Firmware Changes

- **ALWAYS** make firmware modifications through overlays under `overlays/`.
- **ALWAYS** keep overlay order and numbering consistent.
- **ALWAYS** place patch files in the correct `patches/` subdirectory so they map to the intended firmware root path.Spoolman rejected the data — if you use extra fields, register them first in Config
- **ALWAYS** add new files via `root/` or `scripts/` in the overlay, not by editing extracted firmware directly.

### 3. Shell and Script Quality

- **ALWAYS** use `set -e` in scripts so failures stop execution.
- **ALWAYS** prefer explicit paths and environment variables over hardcoded assumptions.
- **ALWAYS** keep scripts readable and maintainable.
- **ALWAYS** update documentation when changing build or deployment behavior.

### 4. Repository Workflows

- **ALWAYS** keep commits focused and self-contained.
- **ALWAYS** follow the repository's existing naming and layout conventions for overlays and scripts.
- **ALWAYS** validate changes with the appropriate build target before finishing work.

## Project Structure

```
.
├── .github/                   GitHub workflows and dev container config
├── overlays/                  Modular firmware overlays
│   ├── common/                Core overlays applied to all profiles
│   ├── devel/                 Development-only overlays used with DEVEL=1
│   └── firmware-<profile>/    Profile-specific overlays
├── firmware/                  Downloaded and generated firmware images
├── scripts/                   Build and deployment helpers
├── tools/                     Utility tools and firmware image helpers
├── tmp/                       Temporary build artifacts
├── Makefile                   Build target definitions
└── vars.mk                    Base firmware and kernel configuration
```

## Essential Commands

### Build environment

```bash
./dev.sh bash
```

### Prepare toolchain and firmware

```bash
./dev.sh make tools
./dev.sh make firmware
```

### Build extended firmware

```bash
./dev.sh make build PROFILE=extended OUTPUT_FILE=firmware/U1_extended.bin
```

### Build extended firmware with development overlays

```bash
./dev.sh make build PROFILE=extended-devel OUTPUT_FILE=firmware/U1_extended_devel.bin
```

### Extract firmware for inspection

```bash
./dev.sh make extract
```

### Upgrade a connected printer

```bash
./dev.sh ./scripts/dev/upgrade-firmware.sh root@<printer-ip> extended
```

### Run repository tests

```bash
./dev.sh make test
```

## Security and Quality

- **NEVER** hardcode secrets or passwords in the repository.
- **ALWAYS** keep firmware modifications isolated and auditable.
- **ALWAYS** preserve compatibility with the base Snapmaker firmware where possible.
- **ALWAYS** verify patch paths and overlay contents before building.

## Troubleshooting

- If a build fails, inspect the overlay ordering and patch application path.
- If firmware extraction or rebuild seems stale, remove `tmp/` and retry.
- If an overlay change does not apply, ensure the overlay directory naming and `Makefile` profile configuration are correct.