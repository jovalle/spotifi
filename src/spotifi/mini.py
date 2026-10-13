"""Build and manage the macOS companion."""

import hashlib
import json
import os
import plistlib
import re
import secrets
import urllib.request
from pathlib import Path

from . import spotify, ui
from .config import MINI_ID, load_mini_config, mini_agent, mini_binary, mini_config, mini_directory
from .resources import ROOT
from .system import atomic_write, current_platform, private_write, run


def write_plist_if_changed(path, desired):
    try:
        if plistlib.loads(path.read_bytes()) == desired:
            return False
    except (OSError, ValueError, plistlib.InvalidFileException):
        pass
    atomic_write(path, plistlib.dumps(desired))
    return True


def mini_prepare():
    directory, config, binary = mini_directory(), mini_config(), mini_binary()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    disabled = config.with_name("config.disabled.json")
    if not config.exists() and disabled.exists():
        disabled.rename(config)
    if not config.exists():
        private_write(
            config,
            json.dumps(
                {
                    "token": secrets.token_hex(32),
                    "port": 47683,
                    "keys": ["m", "h", "l", "p", "r"],
                    "modifiers": 6400,
                }
            ).encode(),
        )
    load_mini_config()
    config.chmod(0o600)
    binary.parent.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256((ROOT / "src/mini-player.swift").read_bytes()).hexdigest()
    source_hash = directory / "source.sha256"
    rebuilt = (
        not binary.is_file()
        or not os.access(binary, os.X_OK)
        or not source_hash.is_file()
        or source_hash.read_text().strip() != fingerprint
    )
    if rebuilt:
        candidate = binary.with_suffix(".new")
        try:
            with ui.spinner("Building Mini Player"):
                run(
                    "xcrun",
                    "swiftc",
                    "-module-cache-path",
                    directory / "swift-cache",
                    ROOT / "src/mini-player.swift",
                    "-o",
                    candidate,
                )
                run(candidate, "--self-test")
                run(candidate, "--validate-config", config)
            candidate.replace(binary)
            atomic_write(source_hash, (fingerprint + "\n").encode())
        finally:
            candidate.unlink(missing_ok=True)
    changed = write_plist_if_changed(
        binary.parent.parent / "Info.plist",
        {
            "CFBundleIdentifier": MINI_ID,
            "CFBundleName": "Mini Player",
            "CFBundleExecutable": "mini",
            "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1",
            "LSUIElement": True,
            "NSHighResolutionCapable": True,
        },
    )
    run(binary, "--self-test")
    run(binary, "--validate-config", config)
    return rebuilt or changed


def mini_stop():
    run("launchctl", "bootout", f"gui/{os.getuid()}/{MINI_ID}", check=False)
    run("pkill", "-f", re.escape(str(mini_binary().parent)) + "/", check=False)


def mini_install():
    rebuilt = mini_prepare()
    spotify.configure(yes=True)
    directory, agent = mini_directory(), mini_agent()
    changed = write_plist_if_changed(
        agent,
        {
            "Label": MINI_ID,
            "ProgramArguments": [str(mini_binary()), str(mini_config())],
            "RunAtLoad": True,
            "StandardOutPath": str(directory / "stdout.log"),
            "StandardErrorPath": str(directory / "stderr.log"),
        },
    )
    if (
        not changed
        and not rebuilt
        and run("launchctl", "print", f"gui/{os.getuid()}/{MINI_ID}", check=False).returncode == 0
    ):
        ui.ok("Mini Player is current.")
        return
    mini_stop()
    run("launchctl", "bootstrap", f"gui/{os.getuid()}", agent)
    ui.ok("Mini Player installed. Toggle with Control+Option+Command+M.")


def mini_uninstall():
    binary = spotify.spicetify_binary()
    if binary is None:
        raise RuntimeError("Spicetify is not installed.")
    location = run(binary, "-c").stdout.strip()
    if not location or not Path(location).is_file():
        raise RuntimeError("Failed to locate the Spicetify configuration.")
    config = Path(location)
    spotify_path = spotify.config_value(config, "spotify_path")
    if not spotify_path:
        raise RuntimeError("Spicetify has no Spotify path; companion was not disabled.")
    mini_stop()
    mini_agent().unlink(missing_ok=True)
    for path in (
        config.parent / "Extensions/mini-bridge.json",
        Path(spotify_path) / "Apps/xpui/extensions/mini-bridge.json",
    ):
        path.unlink(missing_ok=True)
    if mini_config().is_file():
        mini_config().replace(mini_config().with_name("config.disabled.json"))
    print("Companion disabled; preferences retained.")


def mini_reload():
    if current_platform() != "Darwin" or not mini_config().is_file():
        return
    running = (
        run("pgrep", "-f", re.escape(str(mini_binary().parent)) + "/", check=False).returncode == 0
    )
    mini_prepare()
    if mini_agent().is_file():
        mini_stop()
        run("launchctl", "bootstrap", f"gui/{os.getuid()}", mini_agent())
    elif running:
        mini_stop()
        run("open", "-a", mini_directory() / "Mini Player.app", "--args", mini_config())


def mini_status():
    config = load_mini_config()
    request = urllib.request.Request(
        f"http://127.0.0.1:{config['port']}/status",
        headers={"Authorization": "Bearer " + config["token"]},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        print(json.dumps(json.load(response), indent=2))
