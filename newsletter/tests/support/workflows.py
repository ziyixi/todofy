"""Parse CI behavior independently of YAML spelling and indentation."""

import pathlib
from typing import Any

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]


def load(name: str) -> dict[str, Any]:
    """Load a workflow while preserving GitHub's on key and scalar strings."""
    value: object = yaml.load(
        (ROOT / ".github/workflows" / name).read_text(),
        Loader=yaml.BaseLoader,
    )
    assert isinstance(value, dict)
    return value
