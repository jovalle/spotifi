set shell := ["uv", "run", "python", "-c"]
set quiet

# List the available tasks.
default:
    import subprocess; subprocess.run(["just", "--list"], check=True)

# Reconcile Spotify, the mini player and an existing Stream Deck installation.
configure: dependencies mini spotify streamdeck

# Install missing Spotify and Spicetify dependencies; never install Stream Deck.
dependencies:
    from spotifi.tasks import task; task("dependencies")

# Apply the managed extensions only when the installed state differs.
spotify:
    from spotifi.tasks import task; task("spotify")

# Build and reconcile the macOS companion and login startup.
mini:
    from spotifi.tasks import task; task("mini")

# Install the plugin and ensure a Spotify controls page, if Stream Deck exists.
streamdeck:
    from spotifi.tasks import task; task("streamdeck")

# Preview Stream Deck changes without writing them.
plan:
    from spotifi.tasks import task; task("plan")

# Run JavaScript and Python tests.
test:
    from spotifi.tasks import task; task("test")

# Run Python lint and formatting checks.
lint:
    import subprocess; subprocess.run(["uv", "run", "ruff", "check", "."], check=True); subprocess.run(["uv", "run", "ruff", "format", "--check", "."], check=True)

# Run lint and regression tests.
check: lint test

# Build the source distribution and wheel.
build:
    import subprocess; subprocess.run(["uv", "run", "python", "-m", "build", "--outdir", "build/distributions"], check=True)

# Build and check the companion without starting it.
build-mini:
    from spotifi.tasks import task; task("build-mini")

# Check the companion's native UI and authenticated HTTP bridge.
test-mini:
    from spotifi.tasks import task; task("test-mini")
