.PHONY: check lint fmt test build build-mini test-mini

check: lint test

lint:
	uv run --extra dev ruff check .
	uv run --extra dev ruff format --check .

fmt:
	uv run --extra dev ruff format .
	uv run --extra dev ruff check --fix .

test:
	uv run python -c 'from spotifi.tasks import task; task("test")'

build:
	uv run --extra dev python -m build --outdir build/distributions

build-mini:
	uv run python -c 'from spotifi.tasks import task; task("build-mini")'

test-mini:
	uv run python -c 'from spotifi.tasks import task; task("test-mini")'
