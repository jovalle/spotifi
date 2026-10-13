"""Locate resources in a checkout or an installed wheel."""

from importlib.resources import files
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
_bundled = Path(str(files("spotifi").joinpath("resources")))
ROOT = PROJECT_ROOT if (PROJECT_ROOT / "justfile").is_file() else _bundled
