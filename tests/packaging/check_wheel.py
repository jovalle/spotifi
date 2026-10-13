"""Install a built wheel and verify its CLI and resources outside the checkout."""

import configparser
import os
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
wheel = Path(sys.argv[1]).resolve()
with zipfile.ZipFile(wheel) as archive:
    for directory in ("src/spicetify", "src/streamdeck", "conf"):
        for source in (root / directory).rglob("*"):
            if source.is_file() and "logs" not in source.parts:
                relative = source.relative_to(root).as_posix()
                assert archive.read("spotifi/resources/" + relative) == source.read_bytes(), (
                    relative
                )
    assert (
        archive.read("spotifi/resources/src/mini-player.swift")
        == (root / "src/mini-player.swift").read_bytes()
    )
    assert not any("spotifi/resources/src/darwin/" in name for name in archive.namelist())
    assert not any(
        "__pycache__" in name or "/logs/" in name or ".audit/" in name
        for name in archive.namelist()
    )
    entries = configparser.ConfigParser()
    entry_file = next(
        name for name in archive.namelist() if name.endswith(".dist-info/entry_points.txt")
    )
    entries.read_string(archive.read(entry_file).decode())
    assert entries["console_scripts"]["spotifi"] == "spotifi.cli:entrypoint"

with tempfile.TemporaryDirectory(prefix="spotifi-wheel-") as temporary:
    outside = Path(temporary)
    environment = outside / "venv"
    venv.EnvBuilder(with_pip=True, symlinks=True).create(environment)
    python = environment / "bin/python"
    subprocess.run(
        [python, "-m", "pip", "install", "--no-index", "--no-deps", wheel],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    clean = {
        key: value for key, value in os.environ.items() if key not in ("PYTHONPATH", "PYTHONHOME")
    }
    for command in (
        [environment / "bin/spotifi", "--help"],
        [python, "-I", "-m", "spotifi", "--help"],
    ):
        result = subprocess.run(
            command, cwd=outside, env=clean, capture_output=True, text=True, check=True
        )
        assert "usage: spotifi" in result.stdout
    check = """
from spotifi import resources, spotify, streamdeck
import json
assert resources.ROOT.name == "resources"
assert all((spotify.EXTENSION_DIR / name).is_file() for name in spotify.EXTENSIONS)
assert (resources.ROOT / "src/mini-player.swift").is_file()
source = resources.ROOT / "conf/streamdeck/com.jovalle.spotifi.sdPlugin"
manifest = json.loads((source / "manifest.json").read_text())
assert streamdeck.action("com.elgato.spotify.multimedia", manifest)["UUID"] == "com.elgato.spotify.multimedia"
assert streamdeck.action("com.jovalle.spotifi.queue", manifest)["Name"] == "Queue"
changes = streamdeck.plugin_changes(source, source.parent / "temporary-plugin")
assert any(path.name == "plugin.js" and str(relative) == manifest["CodePath"] for path, relative in changes)
"""
    subprocess.run([python, "-I", "-c", check], cwd=outside, env=clean, check=True)
print("Wheel contents, installed CLI, and bundled resources passed outside the checkout.")
