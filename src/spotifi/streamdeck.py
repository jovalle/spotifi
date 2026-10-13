#!/usr/bin/env python3
"""Reconcile the optional Stream Deck plugin and a Spotify page without replacing user pages."""

import argparse
import copy
import fcntl
import json
import plistlib
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from . import ui
from .resources import ROOT
from .system import atomic_write

PLUGIN_ID = "com.jovalle.spotifi"


def app_running():
    return subprocess.run(["pgrep", "-x", "Stream Deck"], stdout=subprocess.DEVNULL).returncode == 0


def wait_closed():
    for _ in range(50):
        if not app_running():
            return True
        time.sleep(0.1)
    return False


def quit_app():
    # Stream Deck answers the quit event with "User canceled" (-128) and then exits on its own.
    subprocess.run(
        ["/usr/bin/osascript", "-e", 'tell application id "com.elgato.StreamDeck" to quit'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if wait_closed():
        return
    subprocess.run(["pkill", "-TERM", "-x", "Stream Deck"], stdout=subprocess.DEVNULL)
    if not wait_closed():
        raise RuntimeError("Stream Deck did not close; no changes written.")


def installed_app(home):
    for directory in (Path("/Applications"), home / "Applications"):
        for name in ("Elgato Stream Deck.app", "Stream Deck.app"):
            app = directory / name
            if app.is_dir():
                return app
    return None


def action(uuid_value, manifest):
    definition = next((item for item in manifest["Actions"] if item["UUID"] == uuid_value), None)
    if definition:
        return {
            "ActionID": str(uuid.uuid4()),
            "UUID": uuid_value,
            "Name": definition["Name"],
            "Plugin": {key: manifest[key] for key in ("Name", "UUID", "Version")},
            "Settings": {},
            "State": 0,
            "States": [{} for _ in definition["States"]],
            "LinkedTitle": True,
        }
    external = json.loads((ROOT / "conf/streamdeck/dials.json").read_text())
    if uuid_value in external:
        return {"ActionID": str(uuid.uuid4()), **copy.deepcopy(external[uuid_value])}
    if uuid_value != "com.elgato.streamdeck.page.next":
        raise ValueError(f"Unknown Stream Deck action: {uuid_value}")
    return {
        "ActionID": str(uuid.uuid4()),
        "UUID": uuid_value,
        "Name": "Next Page",
        "Plugin": {"Name": "Pages", "UUID": "com.elgato.streamdeck.page", "Version": "1.0"},
        "Settings": {},
        "State": 0,
        "States": [{}],
        "LinkedTitle": True,
    }


def reconcile(profiles, manifest, template):
    """Return desired JSON files; the caller owns backup, app shutdown and atomic writes."""
    changes = {}
    original_controls = {PLUGIN_ID + "." + name for name in ("love", "like", "add")}
    managed_controls = {item["UUID"] for item in manifest["Actions"]} | {
        "com.elgato.spotify.shuffle"
    }
    for profile in sorted(profiles.glob("*.sdProfile")):
        parent = profile / "manifest.json"
        metadata = json.loads(parent.read_text())
        if metadata.get("Device", {}).get("Model") == "AI Stream Deck":
            continue
        plus = metadata.get("Device", {}).get("Model") == "20GBD9901"
        required = {
            identifier
            for position, identifier in template["Controllers"][0]["Actions"].items()
            if plus or position.endswith(",0")
        }
        pages = metadata["Pages"]["Pages"]
        found = False
        columns = 0
        for page_id in pages:
            path = profile / "Profiles" / page_id.upper() / "manifest.json"
            original = json.loads(path.read_text())
            desired = copy.deepcopy(original)
            present = set()
            for controller in desired.get("Controllers", []):
                for position, item in (controller.get("Actions") or {}).items():
                    if controller["Type"] == "Keypad":
                        present.add(item.get("UUID"))
                        columns = max(columns, int(position.split(",")[0]) + 1)
            keypad = next(
                (
                    controller
                    for controller in desired.get("Controllers", [])
                    if controller["Type"] == "Keypad"
                ),
                None,
            )
            occupied = (
                any(
                    item and item.get("UUID") not in managed_controls
                    for position, item in (keypad.get("Actions") or {}).items()
                    if position in template["Controllers"][0]["Actions"] and position.endswith(",1")
                )
                if keypad
                else False
            )
            if plus and original_controls <= present and not occupied:
                for position, identifier in template["Controllers"][0]["Actions"].items():
                    if (
                        position.endswith(",1")
                        and keypad["Actions"].get(position, {}).get("UUID") != identifier
                    ):
                        keypad["Actions"][position] = action(identifier, manifest)
                encoders = next(
                    (
                        controller
                        for controller in desired["Controllers"]
                        if controller["Type"] == "Encoder"
                    ),
                    None,
                )
                if encoders is None:
                    encoders = {"Type": "Encoder", "Actions": {}}
                    desired["Controllers"].append(encoders)
                for position, identifier in template["Controllers"][1]["Actions"].items():
                    current = (encoders.get("Actions") or {}).get(position)
                    if not current or (
                        identifier == PLUGIN_ID + ".seek"
                        and current.get("UUID") == "com.elgato.spotify.queue"
                    ):
                        if encoders.get("Actions") is None:
                            encoders["Actions"] = {}
                        encoders.setdefault("Actions", {})[position] = action(identifier, manifest)
                found = True
            else:
                found |= required <= present
            if desired != original:
                changes[path] = desired
        if not found:
            page_id = str(uuid.uuid4())
            desired = {"Name": template["Name"], "Icon": "", "Controllers": []}
            width = 4 if metadata.get("Device", {}).get("Model") == "20GBD9901" else max(3, columns)
            for controller in template["Controllers"]:
                if controller["Type"] == "Encoder" and not plus:
                    continue
                actions = {}
                for position, uuid_value in controller["Actions"].items():
                    if not plus and position.endswith(",1"):
                        continue
                    x, y = map(int, position.split(","))
                    index = x + 4 * y
                    target = f"{index % width},{index // width}"
                    actions[target] = action(uuid_value, manifest)
                desired["Controllers"].append({"Type": controller["Type"], "Actions": actions})
            changes[profile / "Profiles" / page_id.upper() / "manifest.json"] = desired
            pages.insert(1, page_id)
            changes[parent] = metadata
    if not list(profiles.glob("*.sdProfile")):
        raise RuntimeError(
            "Open Stream Deck and create a device profile, then run just streamdeck again."
        )
    return changes


def plugin_changes(source, destination):
    files = [
        (path, path.relative_to(source))
        for path in source.rglob("*")
        if path.is_file() and "logs" not in path.relative_to(source).parts
    ]
    files.append((ROOT / "src/streamdeck/plugin.js", Path("plugin.js")))
    return [
        (path, relative)
        for path, relative in files
        if (
            not (destination / relative).is_file()
            or path.read_bytes() != (destination / relative).read_bytes()
        )
    ]


def configure(home, app, check=False):
    if app is None:
        ui.skip("Stream Deck is not installed; plugin and page configuration skipped.")
        return 0
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    version = tuple(int(part) for part in info["CFBundleShortVersionString"].split(".")[:2])
    if version < (7, 1):
        raise RuntimeError("Stream Deck 7.1 or later is required.")
    support = home / "Library/Application Support/com.elgato.StreamDeck"
    profiles = support / "ProfilesV3"
    source = ROOT / "conf/streamdeck" / (PLUGIN_ID + ".sdPlugin")
    manifest = json.loads((source / "manifest.json").read_text())
    template = json.loads((ROOT / "conf/streamdeck/page.json").read_text())
    destination = support / "Plugins" / source.name
    changes = reconcile(profiles, manifest, template)
    files = plugin_changes(source, destination)
    if not changes and not files:
        ui.ok("Stream Deck plugin and Spotify page are current.")
        return 0
    ui.skip(f"Stream Deck: {len(files)} plugin files, {len(changes)} profile files to reconcile.")
    if check:
        return 0
    running = app_running()
    if running and not ui.confirm("Stream Deck must restart to apply changes. Restart it now?"):
        ui.skip("Stream Deck configuration skipped; rerun just streamdeck when ready.")
        return 0
    state = home / "Library/Application Support/spotifi"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "streamdeck-configure.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        stopped = False
        try:
            if running:
                with ui.spinner("Closing Stream Deck"):
                    quit_app()
                stopped = True
            # Quitting can flush fresh preferences; build the plan from those saved files.
            changes = reconcile(profiles, manifest, template)
            backup = state / "streamdeck-backups" / str(uuid.uuid4())
            if destination.is_symlink():
                destination.unlink()
            for path, relative in ui.progress(plugin_changes(source, destination), "plugin files"):
                atomic_write(destination / relative, path.read_bytes())
            for path, desired in ui.progress(changes.items(), "profile files"):
                if path.exists():
                    target = backup / path.relative_to(profiles)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, target)
                atomic_write(path, (json.dumps(desired, separators=(",", ":")) + "\n").encode())
        finally:
            if stopped:
                try:
                    subprocess.run(["open", "-a", str(app)], check=True)
                except subprocess.CalledProcessError:
                    ui.warn("Could not reopen Stream Deck; open it manually.")
    ui.ok(
        "SpotiFi plugin and Spotify controls page configured."
        + (" Stream Deck reopened." if stopped else "")
    )
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="show the plan without modifying the app or files"
    )
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        ui.skip("Stream Deck integration requires macOS; skipped.")
        return 0
    home = Path.home()
    return configure(home, installed_app(home), args.check)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"spotifi: {error}", file=sys.stderr)
        sys.exit(1)
