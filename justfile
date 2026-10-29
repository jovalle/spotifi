set shell := ["bash", "-c", 'set -o pipefail; uv sync --inexact --no-progress 2>&1 | sed -E "s/^ +((Building|Built) )/\1/" >&2 && exec uv run --no-sync python -c "$0"']
set quiet

[private]
default:
    import subprocess; subprocess.run(["just", "--list"], check=True)

# Reconcile Spotify, the mini player and an existing Stream Deck installation.
configure:
    from spotifi.tasks import task; task("dependencies"); task("mini"); task("spotify"); task("streamdeck")

# Compare the installed Spotify configuration and extensions with the defined modules.
check:
    import sys; from spotifi.cli import entrypoint; sys.exit(entrypoint(["check"]))
