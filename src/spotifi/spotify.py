"""Spotify setup, Spicetify reconciliation, and playback."""

import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import ui
from .config import load_mini_config, mini_config
from .resources import PROJECT_ROOT, ROOT
from .system import atomic_write, current_platform, private_write, run, same_file

EXTENSIONS = (
    "settings.js",
    "add.js",
    "play.js",
    "like.js",
    "loved-cover.js",
    "love.js",
    "lyrics.js",
    "mini.js",
    "keys.js",
)

EXTENSION_DIR = ROOT / "src/spicetify"

RETIRED = ("harmonic.js", "spotifai-quick-save.js")

MPRIS_SERVICE = "org.mpris.MediaPlayer2.spotify"

MPRIS_PATH = "/org/mpris/MediaPlayer2"


def config_value(path, key):
    for line in path.read_text().splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == key:
            return value.strip()
    return ""


def has_extension(path, extension):
    return extension in config_value(path, "extensions").replace(" ", "").split("|")


def paths_match(config, spotify, prefs):
    return (
        config.is_file()
        and config_value(config, "spotify_path").rstrip("/") == str(spotify).rstrip("/")
        and config_value(config, "prefs_path") == str(prefs)
    )


def spicetify_binary():
    binary = shutil.which("spicetify")
    local = Path.home() / ".spicetify/spicetify"
    return binary or (str(local) if local.is_file() and os.access(local, os.X_OK) else None)


def ensure_spicetify():
    binary = spicetify_binary()
    if binary:
        return binary
    if not shutil.which("brew"):
        raise RuntimeError("Homebrew is required to install spicetify-cli.")
    with ui.spinner("Installing Spicetify"):
        run("brew", "install", "spicetify-cli")
    binary = spicetify_binary()
    if not binary:
        raise RuntimeError("Spicetify installation did not provide an executable.")
    return binary


def flatpak_installed():
    return bool(
        shutil.which("flatpak")
        and run("flatpak", "info", "com.spotify.Client", check=False).returncode == 0
    )


def dependencies():
    system = current_platform()
    if system == "Darwin":
        if not any(
            (base / "Spotify.app").is_dir()
            for base in (Path("/Applications"), Path.home() / "Applications")
        ):
            if not shutil.which("brew"):
                raise RuntimeError("Homebrew is required to install missing dependencies.")
            with ui.spinner("Installing Spotify"):
                run("brew", "install", "--cask", "spotify")
    elif system == "Linux":
        if not shutil.which("spotify") and not flatpak_installed():
            if not shutil.which("flatpak"):
                raise RuntimeError("Install Flatpak or Spotify before configuring SpotiFi.")
            with ui.spinner("Installing Spotify"):
                run("flatpak", "install", "--user", "-y", "flathub", "com.spotify.Client")
    else:
        raise RuntimeError("SpotiFi supports macOS and Linux.")
    ensure_spicetify()
    ui.ok("Spotify and Spicetify are installed.")


def spotify_paths():
    override = (os.environ.get("SPOTIFI_SPOTIFY_PATH"), os.environ.get("SPOTIFI_SPOTIFY_PREFS"))
    if any(value is not None for value in override):
        if not all(override):
            raise ValueError("Set both SPOTIFI_SPOTIFY_PATH and SPOTIFI_SPOTIFY_PREFS.")
        spotify, prefs = (Path(value).expanduser().resolve() for value in override)
        if not spotify.is_dir() or not prefs.is_file() or not os.access(prefs, os.R_OK):
            raise ValueError("Spotify path must be a directory and prefs must be a readable file.")
        return spotify, prefs
    home = Path.home()
    system = current_platform()
    if system == "Darwin":
        candidates = [
            Path("/Applications/Spotify.app/Contents/Resources"),
            home / "Applications/Spotify.app/Contents/Resources",
        ]
        prefs = home / "Library/Application Support/Spotify/prefs"
    elif system == "Linux":
        candidates = []
        if shutil.which("flatpak"):
            result = run("flatpak", "info", "--show-location", "com.spotify.Client", check=False)
            if result.returncode == 0 and result.stdout.strip():
                candidates.append(Path(result.stdout.strip()) / "files/extra/share/spotify")
        for base in (home / ".local/share/flatpak/app", Path("/var/lib/flatpak/app")):
            candidates.extend(
                sorted(base.glob("com.spotify.Client/*/stable/active/files/extra/share/spotify"))
            )
        candidates.append(Path("/usr/share/spotify"))
        prefs = home / ".var/app/com.spotify.Client/config/spotify/prefs"
        if not os.access(prefs, os.R_OK):
            prefs = home / ".config/spotify/prefs"
    else:
        ui.skip(f"Skipping Spotify configuration: unsupported platform {system}.")
        return None
    spotify = next((path for path in candidates if path.is_dir()), None)
    if spotify is None:
        ui.skip("Skipping Spotify configuration: Spotify is not installed.")
    elif not os.access(prefs, os.R_OK):
        ui.skip("Skipping Spotify configuration: open Spotify and sign in first.")
    else:
        return spotify, prefs
    return None


def ensure_spotify_writable(spotify):
    if current_platform() != "Linux" or all(
        os.access(path, os.W_OK) for path in (spotify, spotify / "Apps")
    ):
        return
    raise RuntimeError(
        "Spicetify needs write access to the Spotify installation.\n"
        f"sudo chmod a+wr -- {shlex.quote(str(spotify))}\n"
        f"sudo chmod -R a+wr -- {shlex.quote(str(spotify / 'Apps'))}"
    )


def spotify_is_running():
    return (
        run(
            "pgrep", "-f", "/spotify( |$)|Spotify.app/Contents/MacOS/Spotify", check=False
        ).returncode
        == 0
    )


def flatpak_is_running():
    return run("pgrep", "-f", "/app/extra/share/spotify/spotify", check=False).returncode == 0


def mpris(method, *args):
    if not shutil.which("gdbus"):
        return subprocess.CompletedProcess(["gdbus"], 1, "")
    return run(
        "gdbus",
        "call",
        "--session",
        "--dest",
        MPRIS_SERVICE,
        "--object-path",
        MPRIS_PATH,
        "--method",
        method,
        *args,
        check=False,
    )


def stop_spotify():
    if not spotify_is_running():
        return
    system = current_platform()
    if system == "Darwin":
        run("osascript", "-e", 'tell application "Spotify" to quit')
    elif system == "Linux":
        # A graceful quit lets Spotify persist its window bounds.
        if mpris("org.mpris.MediaPlayer2.Quit").returncode == 0:
            for _ in range(25):
                if not spotify_is_running():
                    return
                time.sleep(0.2)
        if flatpak_is_running() and shutil.which("flatpak"):
            run("flatpak", "kill", "com.spotify.Client")
        else:
            run("pkill", "-TERM", "-f", "/spotify( |$)")
    else:
        raise RuntimeError(f"Unsupported platform: {system}")
    for _ in range(50):
        if not spotify_is_running():
            return
        time.sleep(0.2)
    raise RuntimeError("Spotify did not stop; configuration was not changed.")


def open_spotify(uri="", was_flatpak=None):
    system = current_platform()
    if system == "Darwin":
        run("open", uri) if uri else run("open", "-a", "Spotify")
    elif system == "Linux":
        if was_flatpak is True or (was_flatpak is None and flatpak_installed()):
            command = ["flatpak", "run", "com.spotify.Client"]
        else:
            candidates = [
                os.environ.get("SPOTIFI_SPOTIFY_BINARY", ""),
                shutil.which("spotify"),
                "/usr/bin/spotify",
                "/usr/local/bin/spotify",
            ]
            binary = next(
                (
                    path
                    for path in candidates
                    if path
                    and Path(path).is_file()
                    and os.access(path, os.X_OK)
                    and Path(path).resolve() != (PROJECT_ROOT / "bin/spotifi").resolve()
                    and Path(path).resolve() != Path(sys.argv[0]).resolve()
                ),
                None,
            )
            if binary is None:
                raise RuntimeError("Spotify is not installed.")
            command = [binary]
        if uri:
            command.append("--uri=" + uri)
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    else:
        raise RuntimeError(f"Unsupported platform: {system}")


def confirm_close():
    tty = os.environ.get("SPOTIFI_SPOTIFY_TTY", "/dev/tty")
    try:
        with open(tty) as stream:
            print("Spotify is running. Close it now? [yes] ", end="", file=sys.stderr, flush=True)
            answer = stream.readline()
    except OSError as error:
        raise RuntimeError(
            "Could not confirm closing Spotify: no interactive input is available."
        ) from error
    if not answer:
        raise RuntimeError("Could not confirm closing Spotify: no interactive input is available.")
    return answer.strip().lower() in ("", "y", "yes")


def backup_version(text):
    inside = False
    for line in re.sub(r"\x1b\[[0-9;]*m", "", text).splitlines():
        line = line.strip()
        if line in ("[Backup]", "Backup"):
            inside = True
        elif line.startswith("["):
            inside = False
        elif inside and re.match(r"^version(?:\s|=)", line):
            return re.sub(r"^version\s*=?\s*", "", line)
    return ""


def helper_directory(binary):
    directory = Path(binary).resolve().parent
    return next(
        (
            path
            for path in (
                directory / "jsHelper",
                directory / "libexec/jsHelper",
                directory.parent / "libexec/jsHelper",
            )
            if (path / "spicetifyWrapper.js").is_file()
        ),
        None,
    )


def bundle_is_applied(apps):
    if (
        not apps.is_dir()
        or not any(path.is_dir() for path in apps.iterdir())
        or any(apps.glob("*.spa"))
    ):
        return False
    for marker in ("xpui-modules.js", "xpui-snapshot.js", "xpui.js"):
        path = apps / "xpui" / marker
        if path.is_file() and re.search(r"Spicetify\.(_platform|URI|Snackbar)", path.read_text()):
            return True
    return False


def repair_applied_bundle(binary):
    result = run(binary, "-c", check=False)
    if result.returncode or not result.stdout.strip():
        return False
    config = Path(result.stdout.strip())
    if not config.is_file():
        return False
    spotify = config_value(config, "spotify_path")
    if not spotify:
        return False
    apps = Path(spotify) / "Apps"
    index = apps / "xpui/index.html"
    helper = helper_directory(binary)
    if not os.access(index, os.W_OK) or not bundle_is_applied(apps) or helper is None:
        return False
    helpers = [("spicetifyWrapper", False)]
    for option, name in (
        ("sidebar_config", "sidebarConfig"),
        ("home_config", "homeConfig"),
        ("experimental_features", "expFeatures"),
    ):
        if config_value(config, option) == "1":
            if not (helper / (name + ".js")).is_file():
                return False
            helpers.append((name, True))
    text = index.read_text()
    if "<body>" not in text or "</body>" not in text:
        return False
    patterns = [
        r'\n?<link[^>]+class=["\']userCSS["\'][^>]*>\n?',
        r'\n?<script[^>]+src=["\'](?:helper/(?:spicetifyWrapper|sidebarConfig|homeConfig|expFeatures)\.js|extensions/[^"\']+)["\'][^>]*></script>\n?',
        r"\n?<!-- spicetify helpers -->\n?",
        r"\n?<script>\s*Spicetify\.Config=.*?</script>\n?",
        r"\n?<script>\s*</script>\n?",
    ]
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.S)
    tags = []
    for name, defer in helpers:
        target = index.parent / "helper" / (name + ".js")
        atomic_write(target, (helper / (name + ".js")).read_bytes())
        target.chmod(0o644)
        tags.append(f"<script{' defer' if defer else ''} src='helper/{name}.js'></script>")
    for extension in EXTENSIONS:
        target = index.parent / "extensions" / extension
        atomic_write(target, (EXTENSION_DIR / extension).read_bytes())
        target.chmod(0o644)
    for extension in RETIRED:
        (index.parent / "extensions" / extension).unlink(missing_ok=True)
    version = run(binary, "-v", check=False).stdout.strip()
    settings = {"version": version, "extensions": list(EXTENSIONS), "custom_apps": []}
    head = (
        "\n".join(tags) + "\n<script>\nSpicetify.Config=" + json.dumps(settings) + ";\n</script>\n"
    )
    tail = "".join(
        f"<script defer src='extensions/{extension}'></script>\n" for extension in EXTENSIONS
    )
    atomic_write(
        index,
        text.replace("<body>", "<body>\n" + head, 1)
        .replace("</body>", tail + "</body>", 1)
        .encode(),
    )
    index.chmod(0o644)
    return True


def apply_spicetify(binary, *command):
    result = run(binary, "--no-restart", *command, check=False)
    if result.returncode == 0:
        return
    if "cannot be backed up" in result.stdout and repair_applied_bundle(binary):
        return
    if re.search(r'[Rr]un "spicetify restore backup', result.stdout):
        run(binary, "--no-restart", "restore")
        run(binary, "--no-restart", "backup", "apply")
        return
    if re.search(r'[Rr]un "spicetify backup apply"', result.stdout):
        result = run(binary, "--no-restart", "backup", "apply", check=False)
        if result.returncode == 0:
            return
        if re.search(r'[Rr]un "spicetify restore backup', result.stdout):
            run(binary, "--no-restart", "restore")
            run(binary, "--no-restart", "backup", "apply")
            return
    raise subprocess.CalledProcessError(result.returncode, result.args, output=result.stdout)


def is_applied(spotify):
    xpui = spotify / "Apps/xpui"
    index = xpui / "index.html"
    if not index.is_file() or not (xpui / "helper/spicetifyWrapper.js").is_file():
        return False
    text = index.read_text()
    return (
        "spicetifyWrapper.js" in text
        and not any(
            "extensions/" + name in text
            or (name == "harmonic.js" and (xpui / "extensions" / name).exists())
            for name in RETIRED
        )
        and all(
            "extensions/" + name in text
            and same_file(EXTENSION_DIR / name, xpui / "extensions" / name)
            for name in EXTENSIONS
        )
    )


def mini_bridge(directory, spotify, check=False):
    config = mini_config()
    if current_platform() != "Darwin" or not config.is_file():
        return True
    source = load_mini_config()
    bridge = {"token": source["token"], "port": source["port"]}
    targets = [
        directory / "Extensions/mini-bridge.json",
        spotify / "Apps/xpui/extensions/mini-bridge.json",
    ]
    for target in targets:
        if check:
            try:
                if (
                    json.loads(target.read_text()) != bridge
                    or target.stat().st_mode & 0o777 != 0o600
                ):
                    return False
            except (OSError, ValueError):
                return False
        else:
            private_write(target, json.dumps(bridge).encode())
    return True


def configuration_is_current(binary, spotify, prefs):
    result = run(binary, "-c", check=False)
    if result.returncode or not result.stdout.strip():
        return False
    config = Path(result.stdout.strip())
    return (
        paths_match(config, spotify, prefs)
        and all(
            has_extension(config, name)
            and same_file(EXTENSION_DIR / name, config.parent / "Extensions" / name)
            for name in EXTENSIONS
        )
        and not any(
            has_extension(config, name)
            or (name == "harmonic.js" and (config.parent / "Extensions" / name).exists())
            for name in RETIRED
        )
        and is_applied(spotify)
        and mini_bridge(config.parent, spotify, check=True)
    )


def configure_spicetify(binary, spotify, prefs, force=False):
    location = run(binary, "-c").stdout.strip()
    if not location or not Path(location).is_file():
        raise RuntimeError("Failed to locate the Spicetify configuration.")
    config = Path(location)
    changed = False
    if not paths_match(config, spotify, prefs):
        run(binary, "config", "spotify_path", spotify, "prefs_path", prefs)
        changed = True
    directory = config.parent / "Extensions"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    for name in EXTENSIONS:
        if not same_file(EXTENSION_DIR / name, directory / name):
            private_write(directory / name, (EXTENSION_DIR / name).read_bytes())
            changed = True
        if not has_extension(config, name):
            run(binary, "config", "extensions", name)
            changed = True
    for name in RETIRED:
        installed = directory / name
        if has_extension(config, name):
            # Preserve the third-party picker before removing its duplicate shortcut.
            if name == "spotifai-quick-save.js" and installed.is_file():
                backup = config.parent / "retired-extensions" / name
                if not backup.exists():
                    private_write(backup, installed.read_bytes())
            run(binary, "config", "extensions", name + "-")
            changed = True
        if name == "harmonic.js" and installed.exists():
            installed.unlink()
            changed = True
    if not force and not changed and is_applied(spotify):
        mini_bridge(config.parent, spotify)
        return
    version = backup_version(config.read_text())
    if not version:
        result = run(binary, "config", check=False)
        if result.returncode == 0:
            version = backup_version(result.stdout)
    apply_spicetify(binary, *(["apply"] if version else ["backup", "apply"]))
    mini_bridge(config.parent, spotify)
    for name in RETIRED:
        (spotify / "Apps/xpui/extensions" / name).unlink(missing_ok=True)
    for name in EXTENSIONS:
        target = spotify / "Apps/xpui/extensions" / name
        if not target.is_file():
            raise RuntimeError(f"Extension {name} is missing from the Spotify bundle.")
        if not same_file(EXTENSION_DIR / name, target):
            raise RuntimeError(f"Extension {name} in the Spotify bundle does not match the source.")
    if not is_applied(spotify):
        raise RuntimeError(
            "Spotify bundle is missing the Spicetify helper or extension script tags."
        )


def survives_relaunch(spotify):
    if current_platform() != "Darwin":
        return True
    for _ in range(int(os.environ.get("SPOTIFI_SPOTIFY_RELAUNCH_CHECKS", "20"))):
        if not is_applied(spotify):
            return False
        time.sleep(0.5)
    return True


def configure(force=False, yes=False):
    paths = spotify_paths()
    if paths is None:
        return
    spotify, prefs = paths
    if current_platform() == "Darwin" and mini_config().is_file():
        load_mini_config()
    ensure_spotify_writable(spotify)
    binary = ensure_spicetify()
    if not force and configuration_is_current(binary, spotify, prefs):
        ui.ok("Spotify configuration is current.")
        return
    running = spotify_is_running()
    flatpak = running and flatpak_is_running()
    if running:
        if not (yes or os.environ.get("SPOTIFI_ASSUME_YES") == "1" or confirm_close()):
            raise RuntimeError("Skipping Spotify configuration while Spotify is running.")
        with ui.spinner("Closing Spotify"):
            stop_spotify()
    try:
        with ui.spinner("Applying Spicetify extensions"):
            configure_spicetify(binary, spotify, prefs, force)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError):
        if running:
            try:
                open_spotify(was_flatpak=flatpak)
            except (OSError, RuntimeError, subprocess.CalledProcessError):
                ui.warn("Could not reopen Spotify after the failed apply.")
        raise
    if running:
        with ui.spinner("Reopening Spotify and checking the bundle"):
            open_spotify(was_flatpak=flatpak)
            survived = survives_relaunch(spotify)
        if not survived:
            ui.warn("Spotify updated itself on relaunch; reapplying Spicetify...")
            with ui.spinner("Closing Spotify"):
                stop_spotify()
            try:
                with ui.spinner("Reapplying Spicetify extensions"):
                    configure_spicetify(binary, spotify, prefs, True)
            except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError):
                try:
                    open_spotify(was_flatpak=flatpak)
                except (OSError, RuntimeError, subprocess.CalledProcessError):
                    ui.warn("Could not reopen Spotify after the failed repair.")
                raise
            with ui.spinner("Reopening Spotify and checking the bundle"):
                open_spotify(was_flatpak=flatpak)
                survived = survives_relaunch(spotify)
            if not survived:
                raise RuntimeError(
                    "Spotify replaced the Spicetify bundle again after relaunch; run spotifi apply."
                )
    ui.ok(
        "Spotify configuration complete."
        + (" Spotify reopened." if running else " Settings apply on next launch.")
    )


def mpris_property(name):
    result = mpris("org.freedesktop.DBus.Properties.Get", "org.mpris.MediaPlayer2.Player", name)
    return result.stdout if result.returncode == 0 else ""


def playback_status():
    value = mpris_property("PlaybackStatus")
    return next(
        (status for status in ("Playing", "Paused", "Stopped") if "'" + status + "'" in value), None
    )


def has_existing_playback():
    return "'mpris:trackid'" in mpris_property("Metadata") or "true" in mpris_property("CanGoNext")


def resume_playback():
    status = playback_status()
    if status == "Playing":
        return
    if status not in ("Paused", "Stopped") or not has_existing_playback():
        raise RuntimeError("Spotify has no playback context to resume.")
    result = mpris("org.mpris.MediaPlayer2.Player.Play")
    if result.returncode:
        raise RuntimeError("Spotify playback did not resume.")
    for _ in range(50):
        if playback_status() == "Playing":
            return
        time.sleep(0.1)
    raise RuntimeError("Spotify playback did not resume.")


def open_uri(uri):
    if current_platform() != "Linux":
        open_spotify(uri)
        return
    if playback_status() is not None:
        if mpris("org.mpris.MediaPlayer2.Player.OpenUri", uri).returncode:
            raise RuntimeError("Could not open the Spotify playback route.")
        return
    open_spotify()
    for _ in range(50):
        if mpris("org.mpris.MediaPlayer2.Player.OpenUri", uri).returncode == 0:
            return
        time.sleep(0.2)
    raise RuntimeError("Could not open the Spotify playback route.")


def play(selector="library", mode="sequential", yes=False):
    if (
        not yes
        and os.environ.get("SPOTIFI_ASSUME_YES") != "1"
        and sys.stdin.isatty()
        and has_existing_playback()
    ):
        try:
            answer = input("Spotify already has playback or a queue. Play something else? [no] ")
        except EOFError:
            answer = ""
        if answer.strip().lower() not in ("y", "yes"):
            resume_playback()
            return
    open_uri(
        f"spotify:search:spotifi-play-{selector}-{mode}-{int(time.time())}-{secrets.token_hex(4)}"
    )
