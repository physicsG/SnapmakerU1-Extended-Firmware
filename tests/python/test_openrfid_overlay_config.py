"""Regression checks for the firmware-owned OpenRFID service configuration."""

from configparser import ConfigParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
OVERLAY_DIR = ROOT / "overlays" / "firmware-extended" / "64-app-openrfid"
CONFIG_DIR = (
    OVERLAY_DIR
    / "root"
    / "usr"
    / "local"
    / "share"
    / "openrfid"
    / "extended"
)
INSTALL_SCRIPT = OVERLAY_DIR / "pre-scripts" / "01-install-openrfid.sh"
INIT_SCRIPT = OVERLAY_DIR / "root" / "etc" / "init.d" / "S99openrfid"
SETTINGS_YAML = (
    OVERLAY_DIR
    / "root"
    / "usr"
    / "local"
    / "share"
    / "firmware-config"
    / "functions"
    / "15_settings_openrfid.yaml"
)
EXTENDED2_CFG = (
    ROOT
    / "overlays"
    / "firmware-extended"
    / "02-firmware-config"
    / "root"
    / "usr"
    / "local"
    / "share"
    / "firmware-config"
    / "extended"
    / "extended2.cfg"
)


class OpenRfidInstallationTests(unittest.TestCase):
    def test_installer_pins_writer_and_official_sdk(self):
        text = INSTALL_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("GIT_URL=https://github.com/physicsG/OpenRFID.git", text)
        self.assertIn(
            "GIT_SHA=1d8229b307429adbcb73869d55637a61fee2a284", text
        )
        self.assertIn(
            "TIGERTAG_SDK_SHA=f3e2e2e8a1fdf88f91fb43ca4b5c5fbfb88f81af",
            text,
        )
        self.assertIn('cp -a "$TIGERTAG_SDK_DIR/tigertag/."', text)

    def test_api_override_requires_reviewed_writer_marker(self):
        text = INIT_SCRIPT.read_text(encoding="utf-8")
        marker = 'SAFE_WRITER_MARKER="/usr/local/share/openrfid/SAFE_TIGERTAG_WRITER_V2"'
        gate = 'if [ "$RFID_WRITE" = "true" ] && [ -f "$SAFE_WRITER_MARKER" ]; then'

        self.assertIn(marker, text)
        self.assertIn(gate, text)
        self.assertEqual(text.count("enable_write = true"), 1)
        self.assertLess(text.index(gate), text.index("enable_write = true"))
        for key in (
            "enable_write",
            "allow_unrecognized_write",
            "allow_legacy_migration_write",
        ):
            self.assertIn(f'"$EXTENDED2_CFG" openrfid {key}', text)
        self.assertNotIn('"$EXTENDED2_CFG" components rfid_write', text)

    def test_config_merge_order_is_explicit(self):
        text = INIT_SCRIPT.read_text(encoding="utf-8")
        invocation = text[text.index("start-stop-daemon -S") :]
        expected = (
            "/usr/local/share/openrfid/extended/openrfid_u1_base.cfg",
            '"$DETECT_CONFIG"',
            "$ADDITIONAL_CONFIG",
            '"$STATIC_API_CFG"',
            "$API_OVERRIDE_CONFIG",
        )
        offsets = [invocation.index(value) for value in expected]
        self.assertEqual(offsets, sorted(offsets))

    def test_service_has_no_legacy_spools_migration_or_config_glob(self):
        text = INIT_SCRIPT.read_text(encoding="utf-8")
        for forbidden in (
            "LEGACY_JSON",
            "SPOOLMAN_CFG",
            "MOONRAKER_URL",
            "migrate_legacy_json",
            "for f in /usr/local/share/openrfid/extended/openrfid_*.cfg",
            "/spools",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)

    def test_restart_waits_for_graceful_term_exit(self):
        text = INIT_SCRIPT.read_text(encoding="utf-8")
        wait = text.index('while kill -0 "$PID" 2>/dev/null')
        timeout = text.index("process left running", wait)
        remove = text.index('rm -f "$PIDFILE"', timeout)

        self.assertLess(wait, timeout)
        self.assertLess(timeout, remove)
        self.assertIn("STOP_GRACE_SECONDS=60", text)
        self.assertIn("stop && {", text)
        self.assertNotIn("-s KILL", text)


class OpenRfidConfigurationTests(unittest.TestCase):
    def test_static_api_configuration_is_fail_closed(self):
        parser = ConfigParser(interpolation=None)
        parser.read(CONFIG_DIR / "openrfid_api.cfg", encoding="utf-8")

        self.assertIn("openrfid_agent_event_exporter", parser)
        self.assertEqual(parser["openrfid_api"]["enable_write"], "false")
        self.assertEqual(
            parser["openrfid_api"]["allow_unrecognized_write"], "false"
        )
        self.assertEqual(
            parser["openrfid_api"]["allow_legacy_migration_write"], "false"
        )

    def test_extended_config_keeps_write_policy_out_of_components(self):
        parser = ConfigParser(interpolation=None, allow_no_value=True)
        parser.read(EXTENDED2_CFG, encoding="utf-8")

        self.assertEqual(parser["components"]["rfid"], "snapmaker")
        for key in (
            "enable_write",
            "allow_unrecognized_write",
            "allow_legacy_migration_write",
        ):
            with self.subTest(key=key):
                self.assertNotIn(key, parser["components"])
                self.assertEqual(parser["openrfid"][key], "false")

    def test_firmware_settings_use_prefixed_ids_and_direct_openrfid_keys(self):
        text = SETTINGS_YAML.read_text(encoding="utf-8")
        all_yaml = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (ROOT / "overlays").rglob("*.yaml")
        )
        self.assertIn("\n  openrfid:\n    label: OpenRFID\n", text)
        for item_id, key in (
            ("openrfid-enable-write", "enable_write"),
            ("openrfid-allow-unrecognized-write", "allow_unrecognized_write"),
            (
                "openrfid-allow-legacy-migration-write",
                "allow_legacy_migration_write",
            ),
        ):
            with self.subTest(item_id=item_id):
                self.assertEqual(all_yaml.count(f"      {item_id}:"), 1)
                self.assertIn(f" openrfid {key} true", text)
                self.assertIn(f" openrfid {key} false", text)
        self.assertNotIn(" components rfid_write", text)


if __name__ == "__main__":
    unittest.main()
