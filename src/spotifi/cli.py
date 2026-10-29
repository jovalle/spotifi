"""Command-line parsing and dispatch."""

import argparse
import subprocess
import sys

from . import mini, spotify
from .config import mini_config, mini_directory
from .system import current_platform, failure_details, run


def main(argv=None):
    parser = argparse.ArgumentParser(prog="spotifi", description=__doc__)
    commands = parser.add_subparsers(dest="command")
    for name in ("configure", "update", "apply"):
        command = commands.add_parser(name)
        command.add_argument("-y", "--yes", action="store_true")
        if name == "configure":
            command.add_argument("--force", action="store_true")
    for name in ("open", "stop", "restart", "check"):
        commands.add_parser(name)
    playback = commands.add_parser("play")
    playback.add_argument(
        "selector", nargs="?", default="library", choices=("library", "180g", "liked", "playlist")
    )
    playback.add_argument("-y", "--yes", action="store_true")
    modes = playback.add_mutually_exclusive_group()
    modes.add_argument("--shuffle", dest="mode", action="store_const", const="shuffle")
    modes.add_argument("--smart-shuffle", dest="mode", action="store_const", const="smart-shuffle")
    playback.set_defaults(mode="sequential")
    mini_command = commands.add_parser("mini")
    mini_command.add_argument(
        "action",
        nargs="?",
        default="start",
        choices=("start", "stop", "install", "uninstall", "status", "prepare"),
    )
    args = parser.parse_args(argv)
    if args.command in (None, "configure", "update", "apply"):
        if args.command == "update":
            binary = spotify.spicetify_binary()
            if binary is None:
                raise RuntimeError("Spicetify is not installed.")
            run(binary, "update")
        spotify.configure(force=args.command == "apply" or getattr(args, "force", False), yes=True)
        if args.command == "apply":
            mini.mini_reload()
    elif args.command == "check":
        return spotify.check()
    elif args.command == "play":
        spotify.play(args.selector, args.mode, args.yes)
    elif args.command == "mini":
        if current_platform() != "Darwin":
            raise RuntimeError("Mini player requires macOS.")
        if args.action == "start":
            mini.mini_prepare()
            run("open", "-a", mini_directory() / "Mini Player.app", "--args", mini_config())
        else:
            getattr(mini, "mini_" + args.action)()
    else:
        if args.command in ("stop", "restart"):
            spotify.stop_spotify()
        if args.command in ("open", "restart"):
            spotify.open_spotify()
    return 0


def entrypoint(argv=None):
    try:
        return main(argv)
    except subprocess.CalledProcessError as error:
        print(f"spotifi: {failure_details(error.output or str(error))}", file=sys.stderr)
        return error.returncode if error.returncode > 0 else 1
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"spotifi: {error}", file=sys.stderr)
        return 1
