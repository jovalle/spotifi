"""Developer and setup tasks used by just."""

import glob
import subprocess
import sys

from . import cli, spotify, streamdeck, ui
from .config import mini_binary
from .resources import PROJECT_ROOT
from .system import current_platform, failure_details, run

STEPS = {
    "dependencies": "Dependencies",
    "spotify": "Spotify",
    "mini": "Mini Player",
    "build-mini": "Mini Player build",
    "test-mini": "Mini Player checks",
    "streamdeck": "Stream Deck",
    "plan": "Stream Deck plan",
}


def task(name):
    """Run a just recipe, reporting failures as one line instead of a traceback."""
    try:
        return run_task(name)
    except KeyboardInterrupt:
        print(file=sys.stderr)
        sys.exit(130)
    except subprocess.CalledProcessError as error:
        ui.fail(f"spotifi: {failure_details(error.output or str(error))}")
        sys.exit(error.returncode if error.returncode > 0 else 1)
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        ui.fail(f"spotifi: {error}")
        sys.exit(1)


def run_task(name):
    if name in STEPS:
        ui.step(STEPS[name])
    if name == "dependencies":
        spotify.dependencies()
    elif name == "spotify":
        cli.main(["configure"])
    elif name in ("mini", "build-mini", "test-mini"):
        if current_platform() != "Darwin":
            ui.skip("Mini player requires macOS; skipped.")
            return
        if name == "mini":
            cli.main(["mini", "install"])
        else:
            cli.main(["mini", "prepare"])
            if name == "test-mini":
                print(run(mini_binary(), "--ui-self-test").stdout, end="")
                print(
                    run(
                        sys.executable,
                        PROJECT_ROOT / "tests/native/streamdeck-love-http.py",
                        mini_binary(),
                    ).stdout,
                    end="",
                )
            else:
                ui.ok("Mini Player builds and passes its self-test.")
    elif name in ("streamdeck", "plan"):
        return streamdeck.main(["--check"] if name == "plan" else [])
    elif name == "test":
        for command in (
            [
                "node",
                "--test",
                *sorted(glob.glob(str(PROJECT_ROOT / "tests/javascript/*.test.js"))),
            ],
            [
                sys.executable,
                "-m",
                "unittest",
                "discover",
                "-s",
                str(PROJECT_ROOT / "tests/python"),
                "-p",
                "test_*.py",
            ],
        ):
            subprocess.run(command, check=True, cwd=PROJECT_ROOT)
    else:
        raise ValueError(f"Unknown task: {name}")
