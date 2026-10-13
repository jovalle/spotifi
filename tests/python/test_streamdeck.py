import json
import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from spotifi import streamdeck as deck

root = Path(__file__).resolve().parents[2]
manifest = json.loads(
    (root / "conf/streamdeck/com.jovalle.spotifi.sdPlugin/manifest.json").read_text()
)
template = json.loads((root / "conf/streamdeck/page.json").read_text())


class StreamDeckTests(unittest.TestCase):
    def profile(self, base, page):
        profile = base / "existing.sdProfile"
        leaf = profile / "Profiles/EXISTING/manifest.json"
        leaf.parent.mkdir(parents=True)
        leaf.write_text(json.dumps(page))
        metadata = {
            "Name": "My profile",
            "Version": "2.0",
            "Device": {"Model": "20GBD9901"},
            "Pages": {"Pages": ["existing"], "Current": "existing", "Default": "existing"},
        }
        (profile / "manifest.json").write_text(json.dumps(metadata))
        return profile, leaf, metadata

    def test_missing_app_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self.assertEqual(deck.configure(home, None), 0)
            self.assertEqual(list(home.iterdir()), [])

    def test_fresh_plus_page_reproduces_four_dials_and_installs_plugin_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            profile, _, _ = self.profile(base, {"Controllers": []})
            changes = deck.reconcile(base, manifest, template)
            page = next(data for path, data in changes.items() if path != profile / "manifest.json")
            dials = next(c["Actions"] for c in page["Controllers"] if c["Type"] == "Encoder")
            self.assertEqual(
                [dials[f"{i},0"]["UUID"] for i in range(4)],
                [
                    "com.elgato.spotify.multimedia",
                    "com.jovalle.spotifi.seek",
                    "com.jovalle.spotifi.playlists",
                    "com.elgato.volume-controller.output-device-control",
                ],
            )
            for path, data in changes.items():
                deck.atomic_write(path, json.dumps(data).encode())
            self.assertEqual(deck.reconcile(base, manifest, template), {})
            source = root / "conf/streamdeck" / (deck.PLUGIN_ID + ".sdPlugin")
            destination = base / "plugin"
            for path, relative in deck.plugin_changes(source, destination):
                deck.atomic_write(destination / relative, path.read_bytes())
            self.assertEqual(
                (destination / "plugin.js").read_bytes(),
                (root / "src/streamdeck/plugin.js").read_bytes(),
            )
            self.assertEqual(deck.plugin_changes(source, destination), [])

    def test_queue_becomes_seek_without_overwriting_spotify_adder_or_output_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            dials = {
                position: deck.action(identifier, manifest)
                for position, identifier in template["Controllers"][1]["Actions"].items()
            }
            dials["1,0"] = {"UUID": "com.elgato.spotify.queue", "Settings": {}}
            dials["3,0"]["Settings"]["deviceId"] = "my-output"
            page = {
                "Controllers": [
                    {
                        "Type": "Keypad",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][0][
                                "Actions"
                            ].items()
                        },
                    },
                    {"Type": "Encoder", "Actions": dials},
                ]
            }
            _, leaf, _ = self.profile(base, page)
            updated = deck.reconcile(base, manifest, template)[leaf]["Controllers"][1]["Actions"]
            self.assertEqual(updated["1,0"]["UUID"], "com.jovalle.spotifi.seek")
            for position in ("0,0", "2,0", "3,0"):
                self.assertEqual(updated[position], dials[position])

    def test_existing_spotify_page_is_a_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            page = {
                "Name": "Custom name",
                "Controllers": [
                    {
                        "Type": "Keypad",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][0][
                                "Actions"
                            ].items()
                        },
                    },
                    {
                        "Type": "Encoder",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][1][
                                "Actions"
                            ].items()
                        },
                    },
                ],
            }
            self.profile(base, page)
            self.assertEqual(deck.reconcile(base, manifest, template), {})

    def test_missing_page_added_once_without_overwriting_existing_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            original = {
                "Name": "My work",
                "Controllers": [{"Type": "Keypad", "Actions": {"0,0": {"UUID": "my.work"}}}],
            }
            profile, leaf, metadata = self.profile(base, original)
            changes = deck.reconcile(base, manifest, template)
            self.assertNotIn(leaf, changes)
            parent = profile / "manifest.json"
            self.assertEqual(changes[parent]["Pages"]["Current"], metadata["Pages"]["Current"])
            self.assertEqual(changes[parent]["Pages"]["Default"], metadata["Pages"]["Default"])
            new_page = next(data for path, data in changes.items() if path != parent)
            self.assertEqual(
                new_page["Controllers"][0]["Actions"]["3,0"]["UUID"],
                "com.elgato.streamdeck.page.next",
            )
            for path, desired in changes.items():
                deck.atomic_write(path, json.dumps(desired).encode())
            self.assertEqual(deck.reconcile(base, manifest, template), {})
            self.assertEqual(json.loads(leaf.read_text()), original)

    def test_existing_plus_page_updates_bottom_row_and_preserves_top_and_dials(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            page = {
                "Name": "My Spotify",
                "Controllers": [
                    {
                        "Type": "Keypad",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][0][
                                "Actions"
                            ].items()
                            if position.endswith(",0")
                        },
                    },
                    {
                        "Type": "Encoder",
                        "Actions": {"0,0": {"UUID": "existing.audio", "Settings": {"volume": 47}}},
                    },
                ],
            }
            page["Controllers"][0]["Actions"]["3,1"] = {"UUID": "com.elgato.spotify.shuffle"}
            _, leaf, _ = self.profile(base, page)
            changes = deck.reconcile(base, manifest, template)
            self.assertEqual(set(changes), {leaf})
            updated = changes[leaf]
            self.assertEqual(
                updated["Controllers"][1]["Actions"]["0,0"],
                page["Controllers"][1]["Actions"]["0,0"],
            )
            self.assertEqual(
                updated["Controllers"][1]["Actions"]["2,0"]["UUID"], "com.jovalle.spotifi.playlists"
            )
            for position, identifier in template["Controllers"][0]["Actions"].items():
                self.assertEqual(updated["Controllers"][0]["Actions"][position]["UUID"], identifier)
                if position.endswith(",0"):
                    self.assertEqual(
                        updated["Controllers"][0]["Actions"][position],
                        page["Controllers"][0]["Actions"][position],
                    )
            deck.atomic_write(leaf, json.dumps(updated).encode())
            self.assertEqual(deck.reconcile(base, manifest, template), {})

    def test_occupied_third_dial_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            page = {
                "Controllers": [
                    {
                        "Type": "Keypad",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][0][
                                "Actions"
                            ].items()
                        },
                    },
                    {
                        "Type": "Encoder",
                        "Actions": {
                            "2,0": {"UUID": "existing.collection", "Settings": {"keep": True}}
                        },
                    },
                ]
            }
            _, leaf, _ = self.profile(base, page)
            changes = deck.reconcile(base, manifest, template)
            self.assertEqual(
                changes[leaf]["Controllers"][1]["Actions"]["2,0"],
                page["Controllers"][1]["Actions"]["2,0"],
            )

    def test_occupied_bottom_row_gets_a_separate_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            page = {
                "Controllers": [
                    {
                        "Type": "Keypad",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][0][
                                "Actions"
                            ].items()
                            if position.endswith(",0")
                        },
                    }
                ]
            }
            page["Controllers"][0]["Actions"]["0,1"] = {
                "UUID": "my.work",
                "Settings": {"keep": True},
            }
            profile, leaf, _ = self.profile(base, page)
            changes = deck.reconcile(base, manifest, template)
            self.assertNotIn(leaf, changes)
            self.assertIn(profile / "manifest.json", changes)
            for path, desired in changes.items():
                deck.atomic_write(path, json.dumps(desired).encode())
            self.assertEqual(json.loads(leaf.read_text()), page)
            self.assertEqual(deck.reconcile(base, manifest, template), {})

    def test_seek_forward_key_migrates_to_queue_without_touching_other_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            page = {
                "Controllers": [
                    {
                        "Type": "Keypad",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][0][
                                "Actions"
                            ].items()
                        },
                    }
                ]
            }
            page["Controllers"][0]["Actions"]["0,1"] = deck.action(
                "com.jovalle.spotifi.seek-forward", manifest
            )
            _, leaf, _ = self.profile(base, page)
            changes = deck.reconcile(base, manifest, template)
            updated = changes[leaf]["Controllers"][0]["Actions"]
            self.assertEqual(updated["0,1"]["UUID"], "com.jovalle.spotifi.queue")
            for position, action in page["Controllers"][0]["Actions"].items():
                if position != "0,1":
                    self.assertEqual(updated[position], action)
            for path, desired in changes.items():
                deck.atomic_write(path, json.dumps(desired).encode())
            self.assertEqual(deck.reconcile(base, manifest, template), {})

    def test_other_devices_keep_the_original_curation_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            profile, _, metadata = self.profile(base, {"Controllers": []})
            metadata["Device"]["Model"] = "mini"
            (profile / "manifest.json").write_text(json.dumps(metadata))
            changes = deck.reconcile(base, manifest, template)
            page = next(data for path, data in changes.items() if path != profile / "manifest.json")
            actions = page["Controllers"][0]["Actions"]
            self.assertEqual(len(actions), 4)
            self.assertEqual(actions["0,1"]["UUID"], "com.elgato.streamdeck.page.next")

    def test_invalid_profile_aborts_without_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _, leaf, _ = self.profile(base, {})
            leaf.write_text("{bad")
            with self.assertRaises(ValueError):
                deck.reconcile(base, manifest, template)
            self.assertEqual(leaf.read_text(), "{bad")

    def test_full_configuration_backs_up_and_second_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            app = home / "Applications/Stream Deck.app"
            (app / "Contents").mkdir(parents=True)
            (app / "Contents/Info.plist").write_bytes(
                plistlib.dumps({"CFBundleShortVersionString": "7.5.1"})
            )
            support = home / "Library/Application Support/com.elgato.StreamDeck"
            profiles = support / "ProfilesV3"
            original = {
                "Name": "Keep",
                "Controllers": [
                    {
                        "Type": "Keypad",
                        "Actions": {
                            position: deck.action(identifier, manifest)
                            for position, identifier in template["Controllers"][0][
                                "Actions"
                            ].items()
                        },
                    }
                ],
            }
            # An existing curation page needs its bottom row and dial reconciled.
            original["Controllers"][0]["Actions"] = {
                position: item
                for position, item in original["Controllers"][0]["Actions"].items()
                if position.endswith(",0")
            }
            self.profile(profiles, original)
            outcomes = iter(
                [
                    SimpleNamespace(returncode=0),
                    SimpleNamespace(returncode=0),
                    SimpleNamespace(returncode=1),
                    SimpleNamespace(returncode=0),
                ]
            )
            with (
                patch.dict(os.environ, {"SPOTIFI_ASSUME_YES": "1"}),
                patch.object(
                    deck.subprocess, "run", side_effect=lambda *args, **kwargs: next(outcomes)
                ) as process,
            ):
                self.assertEqual(deck.configure(home, app), 0)
                self.assertEqual(process.call_count, 4)
            backups = home / "Library/Application Support/spotifi/streamdeck-backups"
            self.assertTrue(list(backups.rglob("manifest.json")))
            before = {p: p.stat().st_mtime_ns for p in home.rglob("*") if p.is_file()}
            with patch.object(
                deck.subprocess,
                "run",
                side_effect=AssertionError("current setup must not restart the app"),
            ):
                self.assertEqual(deck.configure(home, app), 0)
            self.assertEqual(
                before, {p: p.stat().st_mtime_ns for p in home.rglob("*") if p.is_file()}
            )

    def quit_with(self, running):
        """Run quit_app against a fake process table; return the commands issued."""
        states = iter(running)
        commands = []

        def process(args, **kwargs):
            commands.append(args[0])
            if args[0] == "pgrep":
                return SimpleNamespace(returncode=0 if next(states) else 1)
            # Stream Deck replies -128 to the quit event even when it then exits.
            return SimpleNamespace(returncode=1 if args[0] == "/usr/bin/osascript" else 0)

        with (
            patch.object(deck.subprocess, "run", side_effect=process),
            patch.object(deck.time, "sleep"),
        ):
            deck.quit_app()
        return commands

    def test_quit_rejected_by_apple_event_still_waits_for_exit(self):
        self.assertEqual(
            self.quit_with([True, True, False]), ["/usr/bin/osascript", "pgrep", "pgrep", "pgrep"]
        )

    def test_quit_falls_back_to_terminate_signal(self):
        commands = self.quit_with([True] * 50 + [False])
        self.assertEqual(commands.count("pkill"), 1)
        self.assertEqual(commands[-2:], ["pkill", "pgrep"])

    def test_quit_that_never_exits_aborts(self):
        with self.assertRaisesRegex(RuntimeError, "did not close"):
            self.quit_with([True] * 100)

    def test_declined_restart_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            app = home / "Applications/Stream Deck.app"
            (app / "Contents").mkdir(parents=True)
            (app / "Contents/Info.plist").write_bytes(
                plistlib.dumps({"CFBundleShortVersionString": "7.5.1"})
            )
            profiles = home / "Library/Application Support/com.elgato.StreamDeck/ProfilesV3"
            _, leaf, _ = self.profile(profiles, {"Controllers": []})
            before = leaf.read_bytes()
            with (
                patch.object(
                    deck.subprocess, "run", return_value=SimpleNamespace(returncode=0)
                ) as process,
                patch.object(deck.ui, "confirm", return_value=False),
            ):
                self.assertEqual(deck.configure(home, app), 0)
            self.assertEqual([c.args[0][0] for c in process.call_args_list], ["pgrep"])
            self.assertEqual(leaf.read_bytes(), before)
            self.assertFalse(
                (home / "Library/Application Support/com.elgato.StreamDeck/Plugins").exists()
            )


if __name__ == "__main__":
    unittest.main()
