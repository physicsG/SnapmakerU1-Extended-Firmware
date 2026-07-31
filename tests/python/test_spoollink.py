from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPOOLLINK_PATH = (
    ROOT
    / "overlays/firmware-extended/38-feature-spoollink/root/home/lava"
    / "moonraker/moonraker/components/spoollink.py"
)
SPEC = importlib.util.spec_from_file_location("firmware_spoollink", SPOOLLINK_PATH)
assert SPEC and SPEC.loader
SPOOLLINK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SPOOLLINK)

UID = "04A1B2C3D4E5F6"


def spool(spool_id: int, owns_uid: bool = True) -> dict:
    return {
        "id": spool_id,
        "extra": {"card_uids": f'"{UID if owns_uid else ""}"'},
        "filament": {
            "material": "PLA",
            "vendor": {"name": "Example"},
            "color_hex": "112233",
            "extra": {"variant": '"Basic"'},
        },
    }


class ResolutionHarness(SPOOLLINK.SpoolLink):
    def __init__(self, selected: dict | None, owners: list[dict]) -> None:
        self.selected = selected
        self.owners = list(owners)
        self._channel_tag_identity = {
            0: {"card_type": "NTAG", "tag_format": "tigertag"}
        }
        self.applied = []
        self.messages = []
        self.removed = []
        self.fail_add = False

    async def _retry(self, fn, *args, **kwargs):
        return await fn(*args, **kwargs)

    async def _spoolman_get_by_id(self, spool_id):
        return self.selected if self.selected and self.selected["id"] == spool_id else None

    async def _spoolman_find_by_card(self, card_uid):
        return list(self.owners)

    async def _spoolman_add_card_uid(self, selected, card_uid):
        if self.fail_add:
            raise RuntimeError("simulated add failure")
        selected["extra"]["card_uids"] = f'"{card_uid}"'
        if all(owner["id"] != selected["id"] for owner in self.owners):
            self.owners.append(selected)
        return selected

    async def _spoolman_remove_card_uid(self, stale, card_uid):
        self.removed.append(stale["id"])
        self.owners = [owner for owner in self.owners if owner["id"] != stale["id"]]
        return stale

    async def _spoollink_set(self, channel, message, info=None, status="ok"):
        self.messages.append((channel, message, status, info))
        return {}

    async def _apply_spool(self, channel, selected, uid_hex, **kwargs):
        self.applied.append((channel, selected, uid_hex, kwargs))

    def _save_cache(self, card_uid, selected):
        pass

    def _delete_cache(self, card_uid):
        pass

    def _load_cache(self, card_uid):
        return None


class SpoolLinkResolutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_selection_repairs_duplicate_uid_owners(self):
        stale = spool(1)
        selected = spool(2)
        link = ResolutionHarness(selected, [stale, selected])

        await link._resolve_spool(0, spool_id=2, card_uid=UID)

        self.assertEqual(link.removed, [1])
        self.assertEqual([owner["id"] for owner in link.owners], [2])
        self.assertEqual(len(link.applied), 1)
        _, applied, uid, identity = link.applied[0]
        self.assertEqual(applied["id"], 2)
        self.assertEqual(uid, UID)
        self.assertEqual(identity["card_type"], "NTAG")
        self.assertEqual(identity["tag_format"], "tigertag")
        self.assertFalse(any(message[2] == "error" for message in link.messages))

    async def test_scan_only_duplicate_uid_still_fails_closed(self):
        link = ResolutionHarness(None, [spool(1), spool(2)])

        await link._resolve_spool(0, card_uid=UID)

        self.assertEqual(link.applied, [])
        self.assertTrue(any(message[2] == "error" for message in link.messages))

    async def test_binding_failure_is_not_reported_as_assignment_success(self):
        selected = spool(2, owns_uid=False)
        link = ResolutionHarness(selected, [])
        link.fail_add = True

        await link._resolve_spool(0, spool_id=2, card_uid=UID)

        self.assertEqual(link.applied, [])
        self.assertTrue(any("assignment failed" in message[1]
                            for message in link.messages))

    async def test_applied_spool_preserves_physical_tag_identity(self):
        link = ResolutionHarness(None, [])

        await SPOOLLINK.SpoolLink._apply_spool(
            link, 0, spool(7), UID, card_type="NTAG", tag_format="tigertag"
        )

        info = link.messages[-1][3]
        self.assertEqual(info["CARD_TYPE"], "NTAG")
        self.assertEqual(info["TAG_FORMAT"], "tigertag")
        self.assertEqual(info["CARD_UID"], [4, 161, 178, 195, 212, 229, 246])


if __name__ == "__main__":
    unittest.main()
