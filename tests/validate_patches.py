"""Validate the syntax and hunk metadata of embedded unified-diff files."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    patches = sorted(
        path for path in ROOT.rglob("*.patch")
        if ".git" not in path.parts
    )
    failures: list[tuple[Path, str]] = []

    for patch in patches:
        result = subprocess.run(
            ["git", "apply", "--numstat", "--", str(patch)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode:
            failures.append((patch.relative_to(ROOT), result.stderr.strip()))

    if failures:
        for patch, error in failures:
            print(f"FAIL {patch}: {error}", file=sys.stderr)
        return 1

    print(f"Validated {len(patches)} embedded patch files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
