"""Shared model-job boundaries: strict JSON and isolated workspace preparation.

No SDK or provider is selected here. Editor-specific context and artifact writes
remain with the editor; research uses the same parser and directory guards.
"""

import datetime
import json
import pathlib
from typing import Any

import newsletter.errors as errors
import newsletter.types as types

MAX_JSON_BYTES = 1_048_576


def load_json(text: str) -> Any:
    """Parse bounded JSON; reject duplicate keys and nonfinite values."""

    def pairs(values: list[tuple[str, Any]]) -> types.Payload:
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_: str) -> None:
        raise ValueError("nonfinite number")

    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_JSON_BYTES:
        raise errors.EditorError("invalid_output")
    try:
        return json.loads(
            text, object_pairs_hook=pairs, parse_constant=constant
        )
    except (ValueError, RecursionError):
        raise errors.EditorError("invalid_output") from None


def prepare_workspace(path: pathlib.Path, issue_date: str) -> pathlib.Path:
    """Create a private job directory without reusing previous draft outputs."""
    try:
        if datetime.date.fromisoformat(issue_date).isoformat() != issue_date:
            raise ValueError
        absolute = path.absolute()
        # Refuse any symlink component, including the final workspace directory.
        if any(p.is_symlink() for p in (absolute, *absolute.parents)):
            raise ValueError
        absolute.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not absolute.is_dir() or absolute == pathlib.Path(absolute.anchor):
            raise ValueError
        for name in ("draft.json", "review.json", "supplemental.json"):
            if (absolute / name).exists() or (absolute / name).is_symlink():
                raise ValueError
        return absolute
    except (ValueError, OSError, TypeError):
        raise errors.EditorError("invalid_input") from None
